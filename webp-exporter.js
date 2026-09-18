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
        mode = 'initial',
        reuseToken = null, forcedWidth = null, forcedHeight = null
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
        attempts
    };
}

module.exports = {
    exportWebp,
    buildResolutionLadder,
    cleanupAllPending,
    cleanupOrphanTemps,
    QUALITY_MIN,
    QUALITY_MAX
};
