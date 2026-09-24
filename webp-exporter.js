/**
 * LookVideoEditor - 애니메이션 WebP 목표 용량 내보내기
 *
 * 고정 품질로는 목표 용량을 보장할 수 없다. 실측 결과 동일한 1080x1920 · q80 · 20fps · 5초
 * 조건에서도 콘텐츠에 따라 3.4MB ~ 6.8MB로 약 2배 차이가 난다(배경이 고주파 디테일인 릴스일수록
 * 커진다). 따라서 실제로 인코딩해 크기를 재고 품질을 탐색해 목표 용량 이하로 맞춘다.
 *
 * 파이프라인:
 *   1) 기존 filter_complex 로 합성한 뒤 구간만 잘라 무손실 중간본 1회 생성 (모든 프로브가 재사용)
 *   2) 목표 해상도에서 품질을 병렬 이진 탐색 (libwebp_anim 은 단일 스레드 → 프로세스 병렬화)
 *   3) 품질 하한에서도 목표 초과면 해상도 하향을 제안하고 사용자 확인을 기다림
 *
 * 최종 결과물은 탐색에서 이긴 프로브 파일을 그대로 옮겨 쓴다(재인코딩 없음).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 품질 탐색 범위. 하한 아래로는 내려가지 않고 해상도 하향을 제안한다.
const QUALITY_MIN = 55;
const QUALITY_MAX = 95;

// 품질 탐색 라운드 수. 라운드당 3개 프로브를 동시에 돌린다 (4 물리 코어 기준).
const MAX_ROUNDS = 3;

/**
 * 탐색용 프레임 솎아내기 비율.
 *
 * libwebp_anim 은 프레임 간 예측을 하지 않아 각 프레임이 독립적으로 인코딩된다
 * (cr_threshold 가 아무 효과가 없었던 이유). 따라서 N분의 1 프레임만 인코딩하면
 * 크기가 정확히 N분의 1 이 되고, 전체 크기를 N배로 예측할 수 있다.
 * 실측: 1080x1920 5초 기준 전체 3085KB / 1/4 솎아내기 779KB(x4 = 3116KB, 오차 +1.0%),
 *       소요 시간 13.9초 → 4.0초 (3.5배 단축).
 */
const PROBE_DECIMATION = 4;

/**
 * 구간 길이에 맞는 솎아내기 비율.
 * 프레임이 적으면 예측 표본이 너무 줄어 오차가 커지므로 단계적으로 낮춘다.
 * (2초 구간 = 40프레임 → 1/4 이면 10프레임뿐)
 */
function decimationFor(frameCount) {
    if (frameCount >= 60) return PROBE_DECIMATION;
    if (frameCount >= 30) return 2;
    return 1;
}

// 예측 오차 대비 안전 여유. 솎아내기 예측이 실제보다 작게 나올 경우를 대비한다.
const SAFETY_RATIO = 0.97;

// 전체 프레임으로 확정 인코딩한 뒤 목표를 넘었을 때 재시도 횟수
const MAX_FULL_RETRIES = 2;

// 해상도 사다리 (긴 변 대비 배율). 종횡비를 유지하며 짝수 픽셀로 반올림한다.
const SCALE_LADDER = [1.0, 0.85, 0.75, 0.667, 0.5625, 0.5, 0.444];

/* ------------------------------------------------------------------ */
/* GIF 동시 저장 (용량 목표 관리)                                       */
/* ------------------------------------------------------------------ */

/**
 * GIF 후보 사다리 — 앞에서부터 **전체 프레임으로 인코딩**해 보고 목표에 들어가는 첫 후보를 쓴다.
 *
 * 왜 예측(솎아내기) 대신 실측인가:
 *   ffmpeg gif 인코더는 기본으로 프레임 간 델타/투명 최적화(gifflags=offsetting+transdiff)를 한다.
 *   프레임을 솎으면 인접 프레임 상관이 사라져 프레임당 비용이 실제보다 커진다(실측 +52.7% 과대).
 *   반면 GIF 인코딩은 webP보다 훨씬 싸므로(1080p 100프레임 ≈ 6초) 그냥 만들어 보는 편이 정확하다.
 *
 * 실측(번들 ffmpeg, 실제 릴스 1080x1920·5초 두 편):
 *   fps12·1080p·128색 21.0 / 47.2MB · fps10·1080p·128색 18.4 / 38.6MB
 *   fps10·0.85·128색 14.0 / 30.0MB · fps10·0.75·96색 10.0 / 22.1MB
 *   fps8·0.667·96색 7.0 / 14.4MB · fps8·0.5625·64색 4.4 / 9.7MB
 *   → 같은 설정에서도 콘텐츠에 따라 2.2배 차이가 나므로 상단은 넉넉히, 하단은 촘촘하게 둔다.
 *   → fps 를 10 이상으로 유지한 채 해상도·색상을 먼저 깎고, 그래도 안 되면 fps 를 내린다.
 */
const GIF_LADDER = [
    { fps: 15, scale: 1.0000, colors: 256, dither: 'bayer:bayer_scale=5' },
    { fps: 12, scale: 1.0000, colors: 128, dither: 'none' },
    { fps: 10, scale: 1.0000, colors: 128, dither: 'none' },
    { fps: 10, scale: 0.8500, colors: 128, dither: 'none' },
    { fps: 10, scale: 0.7500, colors: 96, dither: 'none' },
    { fps: 10, scale: 0.6500, colors: 96, dither: 'none' },
    { fps: 10, scale: 0.5000, colors: 64, dither: 'none' },
    { fps: 8, scale: 0.5000, colors: 64, dither: 'none' },
    { fps: 8, scale: 0.4000, colors: 48, dither: 'none' },
    { fps: 6, scale: 0.3500, colors: 32, dither: 'none' }
];

/** GIF 규격 필터 (fps → scale, 팔레트 생성용/적용용 공통) */
function gifBaseFilter({ fps, width, height }) {
    return `fps=${fps},scale=${width}:${height}:flags=lanczos`;
}

/**
 * 중간본 → GIF 인코딩 1회 (2패스 팔레트).
 *
 * 단일 패스(split→palettegen→paletteuse)는 paletteuse 가 팔레트를 EOF 에서야 받아
 * 전 프레임을 메모리에 버퍼링한다(1080p 100프레임 ≈ 1GB, OOM 실측). 2패스는 같은 결과를
 * 약 250MB 로 만든다. 팔레트는 scale·colors 가 같을 때만 재사용되므로 후보마다 새로 만든다.
 *
 * @returns 생성된 파일 크기(byte)
 */
async function encodeGif(params) {
    const {
        ffmpegBin, intermediatePath, fps, width, height, colors, dither,
        outPath, tempDir, registerProcess, duration = 0
    } = params;

    const base = gifBaseFilter({ fps, width, height });
    const palettePath = path.join(tempDir, `gif_palette_${fps}_${width}_${colors}.png`);
    // GIF 재생 길이 제한 — GIF 는 프레임 수에 거의 비례해 커지므로 길이를 줄이면 같은 용량에서 화질을 올릴 수 있다.
    const trim = (duration > 0) ? ['-t', String(duration)] : [];

    // 1패스: 팔레트 생성
    await runFFmpeg(ffmpegBin, [
        '-y', '-i', intermediatePath, '-an', ...trim,
        '-vf', `${base},palettegen=max_colors=${colors}:stats_mode=diff`,
        palettePath
    ], { registerProcess });

    // 2패스: 팔레트 적용
    await runFFmpeg(ffmpegBin, [
        '-y', '-i', intermediatePath, '-i', palettePath, '-an', ...trim,
        '-filter_complex', `[0:v]${base}[x];[x][1:v]paletteuse=dither=${dither}:diff_mode=rectangle`,
        '-loop', '0', outPath
    ], { registerProcess });

    safeUnlink(palettePath);
    return fs.statSync(outPath).size;
}

/**
 * GIF 단계 — 중간본에서 목표 용량 이하 GIF를 만든다.
 *
 * 사다리를 순서대로 **전체 프레임으로 인코딩**해 보고(=결과물 후보), 목표 이하가 나온 첫 후보를 결과로 쓴다.
 * (솎아내기 예측은 GIF 에서 성립하지 않는다 — 위 사다리 주석 참고. 인코딩이 싸므로 직접 만든다.)
 * 사다리 끝까지 목표를 못 맞추면 마지막 후보를 임시로 남겨 두고 needs_confirm 을 돌려준다.
 *
 * @returns 완료: { status:'completed', outputPath, sizeBytes, targetBytes, exceededTarget,
 *                  fps, width, height, colors, scale, attempts }
 *          미달: { status:'needs_confirm', media:'gif', token, floorSizeBytes, floor:{...}, ... }
 */
async function exportGif(params) {
    const {
        ffmpegBin, intermediatePath, targetBytes, maxWidth, maxHeight,
        tempDir, registerProcess, onProgress, outputPath,
        sourceFps = 20,
        // GIF 재생 길이(초). 0 이면 선택 구간 전체 — 줄이면 같은 용량에서 화질이 올라간다.
        duration = 0,
        // initial      : 사다리 1단계부터 전체 인코딩으로 시도
        // accept-floor : 사용자가 "가장 낮은 설정으로 저장" 선택 — 이미 만든 마지막 후보를 그대로 확정
        mode = 'initial'
    } = params;

    const baseWidth = toEven(maxWidth);
    const baseHeight = toEven(maxHeight);
    // 중간본 fps 보다 높은 fps 는 프레임 복제만 늘리므로 클램프한다
    const dimsOf = (step) => ({
        width: toEven(baseWidth * step.scale),
        height: toEven(baseHeight * step.scale),
        fps: Math.max(1, Math.min(step.fps, Math.round(sourceFps) || step.fps))
    });

    const partialPath = path.join(tempDir, 'gif_candidate.gif');
    const floorStep = GIF_LADDER[GIF_LADDER.length - 1];

    if (mode === 'accept-floor') {
        const dims = dimsOf(floorStep);
        ensureDir(path.dirname(outputPath));
        if (fs.existsSync(partialPath)) {
            commitFile(partialPath, outputPath);
            const sizeBytes = fs.statSync(outputPath).size;
            return {
                status: 'completed', outputPath, sizeBytes, targetBytes,
                exceededTarget: sizeBytes > targetBytes,
                fps: dims.fps, width: dims.width, height: dims.height,
                scale: floorStep.scale, colors: floorStep.colors, duration, attempts: 0
            };
        }
        // 부분 파일이 없으면(프로세스 재시작 등) 최하단 설정으로 새로 만든다
        const sizeBytes = await encodeGif({
            ffmpegBin, intermediatePath, fps: dims.fps,
            width: dims.width, height: dims.height, colors: floorStep.colors, dither: floorStep.dither,
            outPath: outputPath, tempDir, registerProcess, duration
        });
        return {
            status: 'completed', outputPath, sizeBytes, targetBytes,
            exceededTarget: sizeBytes > targetBytes,
            fps: dims.fps, width: dims.width, height: dims.height,
            scale: floorStep.scale, colors: floorStep.colors, duration, attempts: 1
        };
    }

    let attempts = 0;
    let lastTry = null;

    for (let i = 0; i < GIF_LADDER.length; i++) {
        const step = GIF_LADDER[i];
        const dims = dimsOf(step);
        attempts++;

        if (onProgress) {
            onProgress({
                phase: 'gif_try', step: i + 1, totalSteps: GIF_LADDER.length,
                fps: dims.fps, colors: step.colors,
                width: dims.width, height: dims.height, targetBytes, attempt: attempts
            });
        }

        const sizeBytes = await encodeGif({
            ffmpegBin, intermediatePath, fps: dims.fps,
            width: dims.width, height: dims.height, colors: step.colors, dither: step.dither,
            outPath: partialPath, tempDir, registerProcess, duration
        });
        lastTry = { step, dims, sizeBytes };

        if (onProgress) {
            onProgress({
                phase: 'gif_try_size', step: i + 1, totalSteps: GIF_LADDER.length,
                sizeBytes, targetBytes, attempt: attempts
            });
        }

        if (sizeBytes <= targetBytes) {
            ensureDir(path.dirname(outputPath));
            commitFile(partialPath, outputPath);
            return {
                status: 'completed', outputPath, sizeBytes, targetBytes, exceededTarget: false,
                fps: dims.fps, width: dims.width, height: dims.height,
                scale: step.scale, colors: step.colors, duration, attempts
            };
        }
    }

    // 사다리 전체가 목표 초과 — 마지막 후보를 남겨 두고 사용자 판단을 기다린다
    const token = stashIntermediate(intermediatePath, tempDir, {
        maxWidth: baseWidth, maxHeight: baseHeight, targetBytes
    });
    if (onProgress) {
        onProgress({ phase: 'gif_needs_confirm', floorSizeBytes: lastTry.sizeBytes, targetBytes });
    }
    return {
        status: 'needs_confirm',
        media: 'gif',
        token,
        suggestion: null,          // 더 낮출 단계가 없음 — 클라이언트가 정직하게 안내한다
        floorSizeBytes: lastTry.sizeBytes,
        targetBytes,
        width: lastTry.dims.width,
        height: lastTry.dims.height,
        fps: lastTry.dims.fps,
        colors: lastTry.step.colors,
        attempts
    };
}

/** 임시 후보 파일을 결과 경로로 확정 (다른 볼륨이면 복사로 폴백) */
function commitFile(fromPath, toPath) {
    try {
        fs.renameSync(fromPath, toPath);
    } catch (err) {
        fs.copyFileSync(fromPath, toPath);
        safeUnlink(fromPath);
    }
}

/** webP 경로에서 GIF 경로를 만든다 (확장자만 교체 — 상세페이지가 stem 으로 두 포맷을 페어링) */
function gifPathFor(webpPath) {
    return /\.webp$/i.test(webpPath) ? webpPath.replace(/\.webp$/i, '.gif') : `${webpPath}.gif`;
}

// 대기 중인 중간본 토큰 보관 시간 (사용자가 확인 다이얼로그를 방치한 경우 정리)
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** 보류 중인 중간본: token -> { intermediatePath, tempDir, createdAt, meta } */
const pendingIntermediates = new Map();

/* ------------------------------------------------------------------ */
/* 유틸                                                                */
/* ------------------------------------------------------------------ */

function toEven(value) {
    const n = Math.round(value / 2) * 2;
    return Math.max(2, n);
}

/** 프로젝트 해상도에서 시작하는 해상도 사다리 생성 (중복 제거) */
function buildResolutionLadder(maxWidth, maxHeight) {
    const ladder = [];
    const seen = new Set();
    for (const factor of SCALE_LADDER) {
        const width = toEven(maxWidth * factor);
        const height = toEven(maxHeight * factor);
        const key = `${width}x${height}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ladder.push({ width, height });
    }
    return ladder;
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) { /* 정리 실패는 치명적이지 않음 */ }
}

function safeRemoveDir(dir) {
    try {
        if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* 정리 실패는 치명적이지 않음 */ }
}

/** ffmpeg 프로세스를 실행하고 종료를 기다린다. stderr 는 진행 파싱용으로 전달된다. */
function runFFmpeg(ffmpegBin, args, options = {}) {
    const { onStderr, registerProcess } = options;
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(ffmpegBin, args, { windowsHide: true });
        } catch (err) {
            reject(err);
            return;
        }
        if (registerProcess) registerProcess(child);

        let stderrTail = '';
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            stderrTail += text;
            if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
            if (onStderr) onStderr(text);
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg 종료 코드 ${code}\n${stderrTail.slice(-600)}`));
        });
    });
}

/* ------------------------------------------------------------------ */
/* 1단계: 무손실 중간본                                                */
/* ------------------------------------------------------------------ */

/**
 * 기존 filter_complex 로 프로젝트 해상도 합성을 수행한 뒤, 타임라인 구간만 잘라
 * 무손실 중간본을 만든다. base_canvas 가 절대 타임라인 기준으로 합성하므로
 * 출력 단계 시킹(-map 뒤)이 합성 결과를 정확히 잘라낸다.
 */
async function renderIntermediate(params) {
    const {
        ffmpegBin, rawInputs, filterComplex, mappedVideo, mappedAudio,
        rangeStart, rangeDuration, fps, outPath, registerProcess
    } = params;

    ensureDir(path.dirname(outPath));
    const filterScriptPath = `${outPath}.filter.txt`;

    // WebP 에는 오디오가 필요 없지만, 그래프의 오디오 출력을 그냥 두면
    // ffmpeg 7.x 가 "Filter has output unconnected" 로 거부한다.
    // anullsink 로 명시적으로 소비시켜 인코딩 없이 버린다.
    const filters = filterComplex.slice();
    if (mappedAudio) {
        filters.push(`${mappedAudio}anullsink`);
    }
    fs.writeFileSync(filterScriptPath, filters.join(';\n'), 'utf8');

    const args = ['-y'];
    rawInputs.forEach((input) => {
        if (input.ss) args.push('-ss', String(input.ss));
        if (input.t) args.push('-t', String(input.t));
        args.push('-i', input.path);
    });

    args.push('-filter_complex_script', filterScriptPath);
    args.push('-map', mappedVideo);
    // 구간 잘라내기 (출력 시킹)
    args.push('-ss', rangeStart.toFixed(3));
    args.push('-t', rangeDuration.toFixed(3));
    args.push('-r', String(fps));
    args.push('-c:v', 'libx264', '-qp', '0', '-preset', 'veryfast');
    args.push(outPath);

    try {
        await runFFmpeg(ffmpegBin, args, { registerProcess });
    } finally {
        safeUnlink(filterScriptPath);
    }

    if (!fs.existsSync(outPath)) {
        throw new Error('중간본 생성에 실패했습니다.');
    }
    return outPath;
}

/* ------------------------------------------------------------------ */
/* 2단계: 품질 탐색                                                    */
/* ------------------------------------------------------------------ */

/**
 * 중간본 → WebP 인코딩 1회. 생성된 파일 크기(byte)를 반환한다.
 * decimate > 1 이면 N프레임마다 하나만 인코딩해 탐색을 빠르게 한다.
 * (-fps_mode passthrough 가 없으면 ffmpeg 가 버린 프레임을 복제해 채워 버린다.)
 */
async function encodeWebp(params) {
    const {
        ffmpegBin, intermediatePath, width, height, quality, outPath,
        decimate = 1, registerProcess
    } = params;

    const filters = [];
    if (decimate > 1) {
        filters.push(`select='not(mod(n\\,${decimate}))'`);
    }
    filters.push(`scale=${width}:${height}:flags=lanczos`);

    const args = ['-y', '-i', intermediatePath, '-vf', filters.join(',')];
    if (decimate > 1) {
        args.push('-fps_mode', 'passthrough');
    }
    args.push('-c:v', 'libwebp_anim', '-q:v', String(quality), '-loop', '0', outPath);

    await runFFmpeg(ffmpegBin, args, { registerProcess });
    return fs.statSync(outPath).size;
}

/**
 * 목표 용량을 만족하는 최대 품질을 병렬 이진 탐색으로 찾는다.
 * 크기는 품질에 단조 증가하므로 브래킷을 좁혀 나간다.
 *
 * 탐색은 솎아낸 프레임으로 수행하고(3.5배 빠름), 결과 크기에 솎아내기 비율을
 * 곱해 전체 프레임 기준 예상 크기로 환산한다.
 *
 * @returns {{ fitted, quality?, predictedBytes?, floorPredictedBytes?,
 *             slopeBytesPerQ?, probes }}
 */
async function searchQuality(params) {
    const {
        ffmpegBin, intermediatePath, width, height, targetBytes,
        frameCount, tempDir, registerProcess, onProgress
    } = params;

    const decimation = decimationFor(frameCount);

    // 솎아낸 프레임에 적용할 목표 (전체 목표를 비율로 나눈 값)
    const probeTarget = (targetBytes * SAFETY_RATIO) / decimation;
    const sizeCache = new Map();   // quality(string) -> { probeBytes, predictedBytes, outPath }
    let probeCount = 0;

    async function probe(quality) {
        const key = quality.toFixed(1);
        if (sizeCache.has(key)) return sizeCache.get(key);

        const outPath = path.join(tempDir, `probe_${key}.webp`);
        const probeBytes = await encodeWebp({
            ffmpegBin, intermediatePath, width, height, quality, outPath,
            decimate: decimation, registerProcess
        });
        probeCount++;

        const entry = { probeBytes, predictedBytes: probeBytes * decimation, outPath };
        sizeCache.set(key, entry);
        if (onProgress) {
            onProgress({
                phase: 'search', probes: probeCount, quality,
                sizeBytes: entry.predictedBytes, targetBytes
            });
        }
        return entry;
    }

    async function probeRound(qualities) {
        const unique = [...new Set(qualities.map((q) => Math.round(q * 10) / 10))]
            .filter((q) => q >= QUALITY_MIN && q <= QUALITY_MAX);
        const results = await Promise.all(unique.map((q) => probe(q)));
        return unique.map((q, i) => ({ quality: q, ...results[i] }));
    }

    // 라운드 1: 범위 양 끝과 중앙을 동시에 확인
    let fitted = null;        // 목표 이하를 만족한 최고 품질
    let nonFitting = null;    // 목표를 초과한 최저 품질
    let floorEntry = null;    // 품질 하한 결과 (실패 시 해상도 제안용)

    const firstRound = await probeRound([
        QUALITY_MIN,
        (QUALITY_MIN + QUALITY_MAX) / 2,
        QUALITY_MAX
    ]);

    for (const entry of firstRound) {
        if (entry.quality === QUALITY_MIN) floorEntry = entry;
        if (entry.probeBytes <= probeTarget) {
            if (!fitted || entry.quality > fitted.quality) fitted = entry;
        } else if (!nonFitting || entry.quality < nonFitting.quality) {
            nonFitting = entry;
        }
    }

    // 최대 품질에서도 통과 → 더 올릴 수 없으므로 종료
    if (!nonFitting && fitted) {
        return { fitted: true, quality: fitted.quality, predictedBytes: fitted.predictedBytes, probes: probeCount };
    }
    // 품질 하한에서도 초과 → 해상도를 낮춰야 함
    if (!fitted) {
        return {
            fitted: false,
            floorPredictedBytes: floorEntry ? floorEntry.predictedBytes : null,
            probes: probeCount
        };
    }

    // 라운드 2..N: fitted 와 nonFitting 사이를 좁힌다
    for (let round = 1; round < MAX_ROUNDS; round++) {
        const span = nonFitting.quality - fitted.quality;
        if (span <= 1.5) break;

        const candidates = [
            fitted.quality + span * 0.25,
            fitted.quality + span * 0.5,
            fitted.quality + span * 0.75
        ];

        const entries = await probeRound(candidates);
        for (const entry of entries) {
            if (entry.probeBytes <= probeTarget) {
                if (entry.quality > fitted.quality) fitted = entry;
            } else if (entry.quality < nonFitting.quality) {
                nonFitting = entry;
            }
        }
    }

    // 재시도 시 품질 보정에 쓸 국소 기울기 (byte / 품질 1점)
    let slopeBytesPerQ = null;
    if (nonFitting && nonFitting.quality > fitted.quality && nonFitting.predictedBytes > fitted.predictedBytes) {
        slopeBytesPerQ = (nonFitting.predictedBytes - fitted.predictedBytes) / (nonFitting.quality - fitted.quality);
    }

    return {
        fitted: true,
        quality: fitted.quality,
        predictedBytes: fitted.predictedBytes,
        slopeBytesPerQ,
        probes: probeCount
    };
}

/**
 * WebP 크기는 화소수에 선형이 아니라 거듭제곱으로 비례한다.
 *
 * 실측(에펠탑 릴스, q=55, 5초):
 *   1080x1920 (2,073,600 px) → 4,430KB
 *    810x1440 (1,166,400 px) → 3,153KB   화소 0.5625배 → 크기 0.712배
 *    720x1280 (  921,600 px) → 2,712KB   화소 0.7901배 → 크기 0.860배
 * 두 구간에서 각각 지수 0.59 / 0.64 가 나오므로 0.6 을 쓴다.
 *
 * 선형(지수 1.0)으로 가정하면 필요 해상도를 너무 크게 잡아, 사용자가 확인을
 * 여러 번 눌러야 했다(810x1440 제안 → 또 미달 → 720x1280 재제안).
 * 지수 0.6 으로 계산하면 720x1280 을 한 번에 제안하고, 예상 크기 오차도 0.4% 였다
 * (예상 2,723KB vs 실측 2,712KB).
 */
const PIXEL_SIZE_EXPONENT = 0.6;

/**
 * 품질 하한에서도 목표를 넘을 때, 목표를 만족할 해상도를 사다리에서 고른다.
 */
function suggestResolution(params) {
    const { ladder, floorSizeBytes, targetBytes, currentWidth, currentHeight } = params;
    if (!floorSizeBytes || floorSizeBytes <= targetBytes) return null;

    const currentPixels = currentWidth * currentHeight;
    const sizeRatio = targetBytes / floorSizeBytes;
    // size ∝ pixels^EXPONENT 이므로 허용 화소 비율은 sizeRatio^(1/EXPONENT)
    const allowedPixels = currentPixels * Math.pow(sizeRatio, 1 / PIXEL_SIZE_EXPONENT);

    let best = null;
    for (const step of ladder) {
        const pixels = step.width * step.height;
        if (pixels <= allowedPixels && pixels < currentPixels) {
            if (!best || pixels > best.width * best.height) best = step;
        }
    }
    // 사다리 최하단도 허용치를 넘으면 가장 작은 단계로
    if (!best && ladder.length > 0) {
        const smallest = ladder[ladder.length - 1];
        if (smallest.width * smallest.height < currentPixels) best = smallest;
    }
    if (!best) return null;

    const estimatedBytes = Math.round(
        floorSizeBytes * Math.pow((best.width * best.height) / currentPixels, PIXEL_SIZE_EXPONENT)
    );
    return { width: best.width, height: best.height, estimatedBytes };
}

/* ------------------------------------------------------------------ */
/* 보류 중간본 토큰 관리                                                */
/* ------------------------------------------------------------------ */

function stashIntermediate(intermediatePath, tempDir, meta) {
    sweepExpiredTokens();
    const token = `webp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    pendingIntermediates.set(token, {
        intermediatePath,
        tempDir,
        meta,
        createdAt: Date.now()
    });
    return token;
}

function takeIntermediate(token) {
    sweepExpiredTokens();
    const entry = pendingIntermediates.get(token);
    if (!entry) return null;
    pendingIntermediates.delete(token);
    return entry;
}

function sweepExpiredTokens() {
    const now = Date.now();
    for (const [token, entry] of pendingIntermediates.entries()) {
        if (now - entry.createdAt > TOKEN_TTL_MS) {
            safeUnlink(entry.intermediatePath);
            safeRemoveDir(entry.tempDir);
            pendingIntermediates.delete(token);
        }
    }
}

/** 서버 종료/취소 시 남은 보류 중간본 정리 */
function cleanupAllPending() {
    for (const entry of pendingIntermediates.values()) {
        safeUnlink(entry.intermediatePath);
        safeRemoveDir(entry.tempDir);
    }
    pendingIntermediates.clear();
}

/**
 * 취소·실패·비정상 종료로 남은 작업 폴더를 정리한다.
 * 성공 경로에서도 임시 폴더를 지우지만, ffmpeg 가 중간에 죽으면 그 정리에 도달하지
 * 못하므로(무손실 중간본이 수십 MB) 이 스윕이 필요하다.
 * 보류 중(needs_confirm 대기)인 토큰의 폴더는 건드리지 않는다.
 *
 * @returns {number} 삭제한 폴더 수
 */
function cleanupOrphanTemps(tempRoot) {
    if (!tempRoot || !fs.existsSync(tempRoot)) return 0;

    const live = new Set();
    sweepExpiredTokens();
    for (const entry of pendingIntermediates.values()) {
        if (entry.tempDir) live.add(path.resolve(entry.tempDir).toLowerCase());
    }

    let removed = 0;
    for (const name of fs.readdirSync(tempRoot)) {
        if (!name.startsWith('webp_')) continue;
        const full = path.join(tempRoot, name);
        if (live.has(path.resolve(full).toLowerCase())) continue;
        safeRemoveDir(full);
        removed++;
    }
    return removed;
}

/* ------------------------------------------------------------------ */
/* 공개 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * WebP 내보내기 1회 수행.
 *
 * @param {object} opts
 *   ffmpegBin, rawInputs, filterComplex, mappedVideo,
 *   rangeStart, rangeDuration, fps,
 *   targetBytes, maxWidth, maxHeight, outputPath, tempRoot,
 *   allowDownscale (false면 목표 미달 시 확인 요청을 반환)
 *   reuseToken (2차 호출 시 보류 중간본 재사용)
 *   forcedWidth/forcedHeight (2차 호출 시 사용자가 승인한 해상도)
 * @param {object} hooks - { onProgress, registerProcess }
 * @returns {Promise<object>} 결과 또는 확인 요청
 */
async function exportWebp(opts, hooks = {}) {
    const { onProgress, registerProcess } = hooks;
    const {
        ffmpegBin, rawInputs, filterComplex, mappedVideo, mappedAudio,
        rangeStart, rangeDuration, fps = 20,
        targetBytes, maxWidth, maxHeight, outputPath,
        tempRoot,
        // 'initial'           : 프로젝트 해상도로 시도, 실패하면 해상도 하향을 제안
        // 'accept-resolution' : 사용자가 승인한 해상도로 시도, 또 실패하면 더 낮은 단계를 제안
        // 'accept-floor'      : 해상도 하향을 거부 — 품질 하한으로 확정하고 초과를 감수
        // 'gif-resume'        : webP 는 이미 저장됨 — 같은 중간본으로 GIF 단계만 이어서 진행
        mode = 'initial',
        reuseToken = null, forcedWidth = null, forcedHeight = null,
        // GIF 동시 저장: { enabled, targetBytes, mode, outputPath, maxWidth, maxHeight, sourceFps }
        gif = null
    } = opts;

    const ladder = buildResolutionLadder(maxWidth, maxHeight);

    // --- 중간본 확보 (2차 호출이면 보관된 것을 재사용) ---
    let intermediatePath;
    let tempDir;
    let stashed;

    if (reuseToken) {
        stashed = takeIntermediate(reuseToken);
        if (!stashed) {
            throw new Error('이전 작업이 만료되었습니다. 처음부터 다시 시도해 주세요.');
        }
        intermediatePath = stashed.intermediatePath;
        tempDir = stashed.tempDir;
    } else {
        tempDir = path.join(tempRoot, `webp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        ensureDir(tempDir);
        intermediatePath = path.join(tempDir, 'intermediate.mp4');

        if (onProgress) onProgress({ phase: 'intermediate', pass: 0, totalPasses: 0 });

        await renderIntermediate({
            ffmpegBin, rawInputs, filterComplex, mappedVideo, mappedAudio,
            rangeStart, rangeDuration, fps,
            outPath: intermediatePath, registerProcess
        });
    }

    // --- GIF 재개 모드: webP 는 이미 저장돼 있으므로 같은 중간본으로 GIF 단계만 수행 ---
    if (mode === 'gif-resume') {
        // 사용자가 "가장 낮은 설정으로 저장"을 선택한 재개 — 이미 만들어 둔 후보를 확정한다
        const gifOutcome = await exportGif({
            ffmpegBin, intermediatePath,
            outputPath: gif.outputPath,
            targetBytes: gif.targetBytes,
            maxWidth: gif.maxWidth || maxWidth, maxHeight: gif.maxHeight || maxHeight,
            tempDir, registerProcess, onProgress,
            sourceFps: gif.sourceFps || fps,
            duration: gif.duration || 0,
            mode: gif.mode || 'accept-floor'
        });
        if (gifOutcome.status === 'needs_confirm') {
            return { status: 'needs_confirm', media: 'gif', gif: gifOutcome, resumeOf: 'gif' };
        }
        safeRemoveDir(tempDir);
        return { status: 'completed', resumeOf: 'gif', outputPath, gif: gifOutcome };
    }

    // --- 탐색 대상 해상도 결정 ---
    // forcedWidth/Height 가 있으면 그것을, 없으면 사다리 최상단(프로젝트 해상도)을 쓴다.
    let searchWidth = forcedWidth || ladder[0].width;
    let searchHeight = forcedHeight || ladder[0].height;

    let quality;
    let floorLocked = false;
    let search = null;

    if (mode === 'accept-floor') {
        // 사용자가 해상도 하향을 거부 → 탐색을 건너뛰고 품질 하한으로 바로 확정한다.
        // (해상도가 그대로라 탐색해 봐야 결과가 같으므로 프로브를 낭비하지 않는다.)
        quality = QUALITY_MIN;
        floorLocked = true;
    } else {
        if (onProgress) {
            onProgress({ phase: 'search', width: searchWidth, height: searchHeight });
        }

        const frameCount = Math.max(1, Math.round(rangeDuration * fps));
        search = await searchQuality({
            ffmpegBin, intermediatePath,
            width: searchWidth, height: searchHeight,
            targetBytes, frameCount, tempDir, registerProcess, onProgress
        });

        if (search.fitted) {
            quality = search.quality;
        } else {
            // 더 낮은 해상도를 제안하고 사용자 확인을 기다린다.
            // ('accept-resolution' 에서도 또 미달이면 한 단계 더 낮춘 제안을 다시 보낸다.)
            const suggestion = suggestResolution({
                ladder,
                floorSizeBytes: search.floorPredictedBytes,
                targetBytes,
                currentWidth: searchWidth,
                currentHeight: searchHeight
            });

            if (suggestion) {
                // 확인을 받으면 이어서 진행할 수 있도록 중간본을 보관한다.
                const token = stashIntermediate(intermediatePath, tempDir, {
                    searchWidth, searchHeight, targetBytes, rangeStart, rangeDuration, fps
                });

                if (onProgress) {
                    onProgress({
                        phase: 'needs_confirm',
                        floorSizeBytes: search.floorPredictedBytes,
                        suggestion
                    });
                }

                return {
                    status: 'needs_confirm',
                    token,
                    searchWidth,
                    searchHeight,
                    floorSizeBytes: search.floorPredictedBytes,
                    targetBytes,
                    suggestion,
                    probes: search.probes
                };
            }

            // 사다리 최하단까지 내려가도 안 되면 하한으로 확정
            quality = QUALITY_MIN;
            floorLocked = true;
        }
    }

    // --- 확정 인코딩 ---
    // 탐색은 솎아낸 프레임으로 했으므로 그 파일을 결과물로 쓸 수 없다.
    // 전체 프레임으로 다시 인코딩하고, 실제 크기가 목표를 넘으면 품질을 낮춰 재시도한다.
    let sizeBytes = 0;
    let attempts = 0;

    ensureDir(path.dirname(outputPath));

    for (;;) {
        attempts++;
        if (onProgress) onProgress({ phase: 'final', quality, attempt: attempts });

        sizeBytes = await encodeWebp({
            ffmpegBin, intermediatePath,
            width: searchWidth, height: searchHeight,
            quality, outPath: outputPath, decimate: 1, registerProcess
        });

        if (sizeBytes <= targetBytes) break;
        if (floorLocked) break;                       // 하한 고정 — 초과를 감수
        if (attempts > MAX_FULL_RETRIES) break;       // 재시도 소진
        if (quality <= QUALITY_MIN) break;            // 더 내려갈 곳 없음

        // 국소 기울기로 목표만큼 줄어들 품질 폭을 추정
        const overshoot = sizeBytes - targetBytes;
        const bytesPerQ = (search && search.slopeBytesPerQ) || sizeBytes * 0.02;
        const drop = Math.max(1, overshoot / bytesPerQ);
        quality = Math.max(QUALITY_MIN, Math.round((quality - drop) * 10) / 10);
    }

    // --- GIF 동시 저장 (선택) ---
    // webP 는 이미 파일로 저장됐다. GIF 는 같은 무손실 중간본에서 뽑으므로 재합성 비용이 없다.
    let gifResult = null;
    if (gif && gif.enabled && gif.targetBytes > 0) {
        const gifOutcome = await exportGif({
            ffmpegBin, intermediatePath,
            outputPath: gif.outputPath || gifPathFor(outputPath),
            targetBytes: gif.targetBytes,
            // GIF 기준 해상도는 항상 원본 프로젝트 해상도 (webP 가 낮춘 해상도를 물려받지 않도록)
            maxWidth: gif.maxWidth || maxWidth, maxHeight: gif.maxHeight || maxHeight,
            tempDir, registerProcess, onProgress,
            sourceFps: gif.sourceFps || fps,
            // 재생 길이 제한 — 프레임 수가 그대로 줄어 같은 용량에서 화질이 올라간다
            duration: gif.duration || 0,
            mode: gif.mode || 'initial'
        });

        if (gifOutcome.status === 'needs_confirm') {
            // webP 는 완료됐고 GIF 만 사용자 판단이 필요하다 → 중간본을 보관한 채 반환
            // (tempDir 를 지우지 않는다 — stashIntermediate 가 재사용을 위해 보관 중)
            return {
                status: 'needs_confirm',
                media: 'gif',
                outputPath,
                webp: {
                    width: searchWidth, height: searchHeight, quality, sizeBytes, targetBytes,
                    exceededTarget: sizeBytes > targetBytes, probes: search ? search.probes : 0, attempts
                },
                gif: gifOutcome
            };
        }
        gifResult = gifOutcome;
    }

    safeRemoveDir(tempDir);

    return {
        status: 'completed',
        outputPath,
        width: searchWidth,
        height: searchHeight,
        quality,
        sizeBytes,
        targetBytes,
        exceededTarget: sizeBytes > targetBytes,
        probes: search ? search.probes : 0,
        attempts,
        gif: gifResult
    };
}

module.exports = {
    exportWebp,
    exportGif,
    gifPathFor,
    GIF_LADDER,
    buildResolutionLadder,
    cleanupAllPending,
    cleanupOrphanTemps,
    QUALITY_MIN,
    QUALITY_MAX
};
