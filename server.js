/**
 * LookVideoEditor - Lightweight Local HTTP & FFmpeg Rendering Server
 * 
 * Node.js 내장 모듈(http, fs, path, child_process)만을 사용하여 별도의 npm install 없이
 * 즉시 실행 가능하며, 웹 에디터 화면과 통신하여 로컬 FFmpeg 렌더링을 원클릭으로 수행합니다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { exportWebp, cleanupAllPending, cleanupOrphanTemps } = require('./webp-exporter');
const { translateQuery, searchMusic, downloadMusic, getQuickKeywords, getRateLimitInfo } = require('./music-search');

// WebP 중간본/프로브 임시 폴더 위치
const WEBP_TEMP_ROOT = path.join(__dirname, 'temp');

// 포트 결정: --port N / --port=N / 위치 인자 / PORT 환경변수 / 기본 3000 (start.bat 독립 실행 호환)
function resolvePort() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) return parseInt(args[i + 1], 10);
        if (args[i].startsWith('--port=')) return parseInt(args[i].split('=')[1], 10);
    }
    const positional = args.find(a => /^\d+$/.test(a));
    if (positional) return parseInt(positional, 10);
    if (process.env.PORT) return parseInt(process.env.PORT, 10);
    return 3000;
}

const PORT = resolvePort();
const ROOT_DIR = __dirname;

// vTonSales 프로젝트 루트 (릴스 저장 폴더 스캔용)
const PROJECT_ROOT = path.resolve(ROOT_DIR, '..');
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi', '.m4v', '.mkv']);

/**
 * 기본 작업 폴더 조회 (Single Source of Truth: .env & data/work_dir.json)
 */
function getWorkDir() {
    // 1. data/work_dir.json 실시간 조회 (Single Source of Truth)
    try {
        const jsonPath = path.join(PROJECT_ROOT, 'data', 'work_dir.json');
        if (fs.existsSync(jsonPath)) {
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (data.work_dir && fs.existsSync(data.work_dir)) {
                const resolved = path.resolve(data.work_dir);
                process.env.WORK_DIR = resolved;
                return resolved;
            }
        }
    } catch (e) {}

    // 2. 루트 .env 실시간 조회
    try {
        const envPath = path.join(PROJECT_ROOT, '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            for (const line of content.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed.startsWith('WORK_DIR=')) {
                    let val = trimmed.slice(9).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1).trim();
                    }
                    if (val && fs.existsSync(val)) {
                        const resolved = path.resolve(val);
                        process.env.WORK_DIR = resolved;
                        return resolved;
                    }
                }
            }
        }
    } catch (e) {}

    // 3. 프로세스 환경변수
    if (process.env.WORK_DIR && fs.existsSync(process.env.WORK_DIR)) {
        return path.resolve(process.env.WORK_DIR);
    }

    // 4. 기본 samples 폴더
    const def = path.join(PROJECT_ROOT, 'samples');
    if (!fs.existsSync(def)) {
        try { fs.mkdirSync(def, { recursive: true }); } catch (e) {}
    }
    return def;
}

/**
 * 기본 작업 폴더 설정 및 영구 저장 (.env & data/work_dir.json)
 */
function setWorkDir(newDir) {
    if (!newDir || typeof newDir !== 'string') {
        return { success: false, error: '유효한 경로를 입력해 주세요.' };
    }
    const resolved = path.isAbsolute(newDir) ? path.resolve(newDir) : path.resolve(PROJECT_ROOT, newDir);
    if (!fs.existsSync(resolved)) {
        return { success: false, error: `폴더가 존재하지 않습니다: ${resolved}` };
    }
    try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            return { success: false, error: `디렉터리가 아닙니다: ${resolved}` };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }

    process.env.WORK_DIR = resolved;

    try {
        const dataDir = path.join(PROJECT_ROOT, 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        const jsonPath = path.join(dataDir, 'work_dir.json');
        fs.writeFileSync(jsonPath, JSON.stringify({
            work_dir: resolved,
            updated_at: new Date().toISOString()
        }, null, 2), 'utf8');
    } catch (e) {
        console.error('[LookVideoEditor] work_dir.json 저장 실패:', e);
    }

    try {
        const envPath = path.join(PROJECT_ROOT, '.env');
        let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        const re = /^WORK_DIR=.*$/m;
        if (re.test(content)) {
            content = content.replace(re, `WORK_DIR=${resolved}`);
        } else {
            content = (content ? content.trimEnd() + '\n' : '') + `WORK_DIR=${resolved}\n`;
        }
        fs.writeFileSync(envPath, content, 'utf8');
    } catch (e) {
        console.error('[LookVideoEditor] .env 갱신 실패:', e);
    }

    return { success: true, work_dir: resolved, name: path.basename(resolved) || resolved };
}

// MIME 타입 매핑
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon'
};

// 외부 영상 폴더 목록 관리
const EXTERNAL_FOLDERS_FILE = path.join(ROOT_DIR, 'external_folders.json');

function getExternalFolders() {
    try {
        if (fs.existsSync(EXTERNAL_FOLDERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(EXTERNAL_FOLDERS_FILE, 'utf8'));
            if (Array.isArray(data)) {
                return data.filter(p => {
                    try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (e) { return false; }
                });
            }
        }
    } catch (e) {}
    return [];
}

function saveExternalFolder(folderPath) {
    try {
        const resolved = path.resolve(folderPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
        const folders = getExternalFolders();
        const index = folders.findIndex(f => f.toLowerCase() === resolved.toLowerCase());
        if (index !== -1) {
            folders.splice(index, 1);
        }
        folders.unshift(resolved);
        fs.writeFileSync(EXTERNAL_FOLDERS_FILE, JSON.stringify(folders.slice(0, 30), null, 2), 'utf8');
    } catch (e) {}
}

function runPowerShell(script, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            windowsHide: false
        });
        let stdout = '';
        let stderr = '';

        timer = setTimeout(() => {
            try { ps.kill(); } catch (e) {}
            reject(new Error('다이얼로그 시간 초과 (취소됨)'));
        }, timeoutMs);

        ps.stdout.on('data', d => { stdout += d.toString('utf8'); });
        ps.stderr.on('data', d => { stderr += d.toString('utf8'); });
        ps.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(stderr || `PowerShell exited with code ${code}`));
        });
        ps.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

// 렌더링 상태 관리
let renderState = {
    isRendering: false,
    progress: 0,
    currentTime: "00:00:00.00",
    totalDuration: 0,
    fps: "0",
    speed: "0x",
    // 'idle' | 'rendering' | 'completed' | 'error' | 'cancelled' | 'needs_confirm'
    status: "idle",
    error: null,
    outputFile: null,
    startTime: 0,
    elapsedTime: "00:00"
};

// 진행 중인 FFmpeg 프로세스들. WebP 는 품질 탐색을 병렬 프로브로 돌리므로 여러 개가 동시에 뜬다.
let activeProcesses = [];

// 해상도 하향 확인을 기다리는 WebP 요청 (사용자가 응답하면 이어서 진행한다)
let pendingWebp = null;
// GIF 단계만 확인 대기 중일 때의 재개 정보 (webP 는 이미 저장 완료)
let pendingGif = null;

function registerProcess(child) {
    activeProcesses.push(child);
    child.on('close', () => {
        activeProcesses = activeProcesses.filter((c) => c !== child);
    });
    return child;
}

/**
 * 임시 폴더 정리를 지연 재시도한다.
 * Windows 는 막 종료된 ffmpeg 가 파일 핸들을 잠시 붙들고 있어 rmSync 가 EBUSY/EPERM 로
 * 실패할 수 있다(취소 직후 실제로 폴더가 남았다). 잠금이 풀린 뒤 다시 쓸어낸다.
 */
function scheduleTempSweep() {
    [1500, 4000, 8000].forEach((delay) => {
        const timer = setTimeout(() => cleanupOrphanTemps(WEBP_TEMP_ROOT), delay);
        if (timer.unref) timer.unref();
    });
}

function killAllProcesses() {
    const list = activeProcesses.slice();
    activeProcesses = [];
    list.forEach((child) => {
        try {
            // Windows 프로세스 트리 강제 종료
            exec(`taskkill /pid ${child.pid} /T /F`, () => {});
        } catch (e) {
            try { child.kill('SIGKILL'); } catch (e2) {}
        }
    });
    return list.length;
}

// 로컬 FFmpeg 바이너리 탐색
function getFFmpegBinary() {
    const localFfmpeg = path.join(ROOT_DIR, 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(localFfmpeg)) {
        return localFfmpeg;
    }
    return 'ffmpeg';
}

function parseTimeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return 0;
}

function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* WebP 내보내기 orchestration                                         */
/* ------------------------------------------------------------------ */

// 단계별 진행률 가중치 (중간본 합성은 짧고, 탐색과 확정 인코딩이 대부분을 차지한다)
// GIF 동시 저장이 켜지면 webP 이후에 GIF 단계가 이어지므로 구간을 나눠 쓴다.
const WEBP_PHASE_WEIGHT = { intermediate: 5, search: 55, final: 25, gif: 15 };

/** GIF 단계 진행 상황을 renderState.gif 에 반영 */
function updateGifProgress(info) {
    if (!renderState.gif) renderState.gif = {};
    const g = renderState.gif;
    g.phase = info.phase;
    if (info.fps !== undefined) g.fps = info.fps;
    if (info.colors !== undefined) g.colors = info.colors;
    if (info.width !== undefined) g.width = info.width;
    if (info.height !== undefined) g.height = info.height;
    if (info.step !== undefined) g.step = info.step;
    if (info.totalSteps !== undefined) g.totalSteps = info.totalSteps;
    if (info.attempt !== undefined) g.attempt = info.attempt;
    if (info.sizeBytes !== undefined) g.sizeBytes = info.sizeBytes;
    if (info.suggestion !== undefined) g.suggestion = info.suggestion;
    if (info.floorSizeBytes !== undefined) g.floorSizeBytes = info.floorSizeBytes;

    // GIF 단계는 webP 완료(80%) 이후 나머지 구간을 나눠 쓴다
    const gifWeight = WEBP_PHASE_WEIGHT.gif;
    const gifStart = WEBP_PHASE_WEIGHT.intermediate + WEBP_PHASE_WEIGHT.search + WEBP_PHASE_WEIGHT.final;
    const total = info.totalSteps || 10;
    let percent = gifStart;
    if (info.phase === 'gif_try' || info.phase === 'gif_try_size') {
        const done = Math.min(info.step || 1, total) / total;
        percent = gifStart + done * (gifWeight - 2);
    } else if (info.phase === 'gif_needs_confirm') {
        percent = 100;
    }
    renderState.progress = Math.max(renderState.progress || 0, Math.min(99, percent));
}

/** GIF 단계 완료를 renderState 에 반영하고 전체 작업을 완료 처리 */
function finishGif(gif) {
    renderState.gif = Object.assign(renderState.gif || {}, {
        phase: 'completed',
        fps: gif.fps,
        width: gif.width,
        height: gif.height,
        colors: gif.colors,
        duration: gif.duration || 0,
        sizeBytes: gif.sizeBytes,
        targetBytes: gif.targetBytes,
        exceededTarget: gif.exceededTarget,
        probes: gif.probes,
        attempts: gif.attempts
    });

    // 다운로드·미리보기용 경로 (프로젝트 루트 기준 상대경로 우선)
    const resolved = path.resolve(gif.outputPath);
    const rel = path.relative(ROOT_DIR, resolved);
    renderState.gifFile = (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : resolved;

    renderState.status = 'completed';
    renderState.progress = 100;
    console.log(`[LookVideoEditor] GIF 완료: ${gif.width}x${gif.height} ${gif.fps}fps ${gif.colors}색 ` +
        `${(gif.sizeBytes / 1048576).toFixed(2)}MB${gif.exceededTarget ? ' (목표 초과)' : ''}`);
}

function updateWebpProgress(info) {
    // GIF 단계 이벤트는 별도 처리
    if (typeof info.phase === 'string' && info.phase.startsWith('gif_')) {
        updateGifProgress(info);
        return;
    }
    if (!renderState.webp) renderState.webp = {};
    const w = renderState.webp;
    w.phase = info.phase;
    if (info.quality !== undefined) w.quality = info.quality;
    if (info.sizeBytes !== undefined) w.sizeBytes = info.sizeBytes;
    if (info.probes !== undefined) w.probes = info.probes;
    if (info.width !== undefined) w.width = info.width;
    if (info.height !== undefined) w.height = info.height;
    if (info.targetBytes !== undefined) w.targetBytes = info.targetBytes;
    if (info.attempt !== undefined) w.attempt = info.attempt;
    if (info.suggestion !== undefined) w.suggestion = info.suggestion;
    if (info.floorSizeBytes !== undefined) w.floorSizeBytes = info.floorSizeBytes;

    // 대략적인 진행률 (탐색은 프로브 수 기준, 최대 12회 가정)
    let percent = 0;
    if (info.phase === 'intermediate') percent = 2;
    else if (info.phase === 'search') {
        const done = Math.min(info.probes || 0, 12) / 12;
        percent = WEBP_PHASE_WEIGHT.intermediate + done * WEBP_PHASE_WEIGHT.search;
    } else if (info.phase === 'final') percent = 80;
    else if (info.phase === 'needs_confirm') percent = 100;

    renderState.progress = Math.max(renderState.progress || 0, Math.min(99, percent));
}

/**
 * WebP 내보내기를 백그라운드로 시작한다. 결과는 renderState 로 흘려보내고
 * 클라이언트는 /api/render/progress 를 폴링한다.
 */
function startWebpExport(params) {
    const {
        rawInputs, filterComplex, mappedVideo, mappedAudio,
        rangeStart, rangeDuration, fps,
        targetBytes, outputWidth, outputHeight, outputFile,
        mode = 'initial', reuseToken = null, forcedWidth = null, forcedHeight = null,
        // GIF 동시 저장: { gifEnabled, gifTargetBytes, gifMode, gifOutputFile }
        gifEnabled = false, gifTargetBytes = 0, gifMode = 'initial', gifOutputFile = null, gifDuration = 0
    } = params;

    // GIF 경로: webP 와 같은 stem, 확장자만 .gif (상세페이지가 stem 으로 두 포맷을 페어링)
    const gifOutputPath = gifOutputFile
        ? path.resolve(ROOT_DIR, gifOutputFile)
        : (outputFile ? path.resolve(ROOT_DIR, String(outputFile).replace(/\.webp$/i, '.gif')) : null);

    // 새 내보내기가 시작되면 이전 확인 대기본은 버린다 (stale 토큰 + 수십 MB 중간본 잔류 방지)
    pendingWebp = null;
    pendingGif = null;

    renderState = {
        isRendering: true,
        progress: 0,
        currentTime: "00:00:00.00",
        totalDuration: rangeDuration,
        fps: String(fps),
        speed: "0x",
        status: 'rendering',
        error: null,
        outputFile,
        startTime: Date.now(),
        elapsedTime: "00:00",
        webp: {
            phase: 'intermediate',
            mode,
            targetBytes,
            width: forcedWidth || outputWidth,
            height: forcedHeight || outputHeight
        },
        gif: (gifEnabled && gifTargetBytes > 0) ? {
            phase: 'pending',
            targetBytes: gifTargetBytes,
            outputFile: gifOutputFile
        } : null
    };

    console.log(`[LookVideoEditor] WebP 내보내기 시작 (mode=${mode}, 목표 ${(targetBytes / 1048576).toFixed(1)}MB, ${rangeDuration}초` +
        `${gifEnabled && gifTargetBytes > 0 ? `, GIF 동시 저장 목표 ${(gifTargetBytes / 1048576).toFixed(1)}MB` : ''})`);

    exportWebp({
        ffmpegBin: getFFmpegBinary(),
        rawInputs,
        filterComplex,
        mappedVideo,
        mappedAudio,
        rangeStart,
        rangeDuration,
        fps,
        targetBytes,
        maxWidth: outputWidth,
        maxHeight: outputHeight,
        outputPath: path.resolve(ROOT_DIR, outputFile),
        tempRoot: WEBP_TEMP_ROOT,
        mode,
        reuseToken,
        forcedWidth,
        forcedHeight,
        gif: (gifEnabled && gifTargetBytes > 0) ? {
            enabled: true,
            targetBytes: gifTargetBytes,
            outputPath: gifOutputPath,
            mode: gifMode,
            // GIF 기준 해상도는 항상 원본 프로젝트 해상도 (webP 가 낮춘 해상도를 물려받지 않도록)
            maxWidth: outputWidth,
            maxHeight: outputHeight,
            sourceFps: fps,
            duration: gifDuration
        } : null
    }, {
        registerProcess,
        onProgress: updateWebpProgress
    })
    .then((result) => {
        renderState.isRendering = false;
        renderState.elapsedTime = formatElapsed(Date.now() - renderState.startTime);

        if (result.status !== 'needs_confirm') {
            // 성공 경로에서도 남은 프로브 파일이 있을 수 있어 스윕한다
            cleanupOrphanTemps(WEBP_TEMP_ROOT);
        }

        // GIF 단계만 재개한 경우 — webP 정보는 이미 완료 상태로 보존돼 있다
        if (result.resumeOf === 'gif') {
            if (result.status === 'needs_confirm') {
                renderState.status = 'needs_confirm';
                renderState.gif = Object.assign(renderState.gif || {}, {
                    phase: 'needs_confirm',
                    token: result.gif.token,
                    floorSizeBytes: result.gif.floorSizeBytes,
                    targetBytes: result.gif.targetBytes,
                    width: result.gif.width,
                    height: result.gif.height,
                    fps: result.gif.fps,
                    colors: result.gif.colors,
                    duration: (pendingGif && pendingGif.duration) || 0
                });
                pendingGif = Object.assign({}, pendingGif, {
                    token: result.gif.token,
                    targetBytes: gifTargetBytes,
                    gifOutputPath
                });
                console.log(`[LookVideoEditor] GIF 목표 미달 ` +
                    `(${(result.gif.floorSizeBytes / 1048576).toFixed(2)}MB) — 사용자 판단 대기`);
                return;
            }
            finishGif(result.gif);
            return;
        }

        if (result.status === 'needs_confirm') {
            // webP 는 이미 저장됐고 GIF 만 사용자 판단이 필요한 경우
            if (result.media === 'gif') {
                renderState.status = 'needs_confirm';
                renderState.outputFile = result.outputPath || outputFile;
                if (result.webp) {
                    renderState.webp = Object.assign(renderState.webp || {}, Object.assign({ phase: 'completed' }, result.webp));
                }
                renderState.gif = Object.assign(renderState.gif || {}, {
                    phase: 'needs_confirm',
                    token: result.gif.token,
                    floorSizeBytes: result.gif.floorSizeBytes,
                    targetBytes: result.gif.targetBytes,
                    width: result.gif.width,
                    height: result.gif.height,
                    fps: result.gif.fps,
                    colors: result.gif.colors,
                    duration: gifDuration
                });
                pendingGif = {
                    token: result.gif.token,
                    targetBytes: gifTargetBytes,
                    gifOutputPath,
                    // GIF 기준 해상도는 항상 원본 프로젝트 해상도 (webP 가 낮춘 값을 물려받지 않도록)
                    outputWidth,
                    outputHeight,
                    sourceFps: fps,
                    duration: gifDuration,
                    outputFile
                };
                console.log(`[LookVideoEditor] webP 완료 · GIF 목표 미달 ` +
                    `(${(result.gif.floorSizeBytes / 1048576).toFixed(2)}MB > 목표 ${(gifTargetBytes / 1048576).toFixed(1)}MB) — 사용자 판단 대기`);
                return;
            }

            // 목표를 맞추려면 해상도를 낮춰야 한다 — 사용자 확인 대기
            renderState.status = 'needs_confirm';
            renderState.webp = Object.assign(renderState.webp || {}, {
                phase: 'needs_confirm',
                token: result.token,
                floorSizeBytes: result.floorSizeBytes,
                suggestion: result.suggestion,
                width: result.searchWidth,
                height: result.searchHeight
            });
            // 사용자가 응답하면 중간본을 재사용해 이어서 진행할 수 있도록 요청을 보관한다.
            pendingWebp = Object.assign({}, params, {
                token: result.token,
                targetBytes,
                outputWidth,
                outputHeight,
                outputFile
            });
            console.log(`[LookVideoEditor] 해상도 하향 필요: ${result.searchWidth}x${result.searchHeight} → ` +
                `${result.suggestion ? `${result.suggestion.width}x${result.suggestion.height}` : '제안 없음'}`);
            return;
        }

        renderState.status = 'completed';
        renderState.progress = 100;
        renderState.outputFile = result.outputPath;
        renderState.webp = Object.assign(renderState.webp || {}, {
            phase: 'completed',
            width: result.width,
            height: result.height,
            quality: result.quality,
            sizeBytes: result.sizeBytes,
            targetBytes: result.targetBytes,
            exceededTarget: result.exceededTarget,
            probes: result.probes
        });
        console.log(`[LookVideoEditor] WebP 완료: ${result.width}x${result.height} q=${result.quality} ` +
            `${(result.sizeBytes / 1048576).toFixed(2)}MB (${renderState.elapsedTime})`);

        if (result.gif) finishGif(result.gif);
    })
    .catch((err) => {
        // 취소·실패로 중단된 작업의 임시 폴더를 정리한다 (무손실 중간본이 수십 MB)
        cleanupOrphanTemps(WEBP_TEMP_ROOT);
        scheduleTempSweep();
        if (renderState.status === 'cancelled') return;
        renderState.isRendering = false;
        renderState.status = 'error';
        renderState.error = err.message;
        console.error('[LookVideoEditor] WebP 내보내기 실패:', err.message);
    });
}

const server = http.createServer(async (req, res) => {
    // CORS 헤더 설정
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;

    // --- API 엔드포인트 ---

    // 0. 기본 작업 폴더 조회
    if (pathname === '/api/work-dir' && req.method === 'GET') {
        const wDir = getWorkDir();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            work_dir: wDir,
            name: path.basename(wDir) || wDir,
            exists: fs.existsSync(wDir)
        }));
        return;
    }

    // 0-1. 기본 작업 폴더 변경
    if (pathname === '/api/work-dir' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const result = setWorkDir(data.work_dir || '');
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // 1. 서버 상태 확인
    if (pathname === '/api/ping' && req.method === 'GET') {
        const ffmpegBin = getFFmpegBinary();
        const hasLocal = fs.existsSync(path.join(ROOT_DIR, 'ffmpeg', 'ffmpeg.exe'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            server: 'LookVideoEditor Server',
            hasLocalFFmpeg: hasLocal,
            ffmpegBinary: ffmpegBin,
            isRendering: renderState.isRendering
        }));
        return;
    }

    // 1-1. Windows 시스템 폰트 목록 조회
    if (pathname === '/api/system-fonts' && req.method === 'GET') {
        try {
            const fontDirs = [
                'C:\\Windows\\Fonts',
                path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')
            ];
            const fontMap = {
                'malgun.ttf': { label: '맑은 고딕 (기본)', key: 'malgun', category: 'gothic' },
                'malgunbd.ttf': { label: '맑은 고딕 Bold', key: 'malgunbd', category: 'gothic' },
                'h2hdrm.ttf': { label: 'HY헤드라인M (굵은 자막 추천)', key: 'hyhead', category: 'display' },
                'h2gtrm.ttf': { label: 'HY견고딕 (또렷한 고딕 추천)', key: 'hygothic', category: 'gothic' },
                'notosanskr-vf.ttf': { label: '본고딕 (Noto Sans KR)', key: 'notosans', category: 'gothic' },
                'notoserifkr-vf.ttf': { label: '본명조 (Noto Serif KR)', key: 'notoserif', category: 'serif' },
                'h2porm.ttf': { label: 'HY엽서M (손글씨체)', key: 'hypost', category: 'display' },
                'h2gsrb.ttf': { label: 'HY궁서B (정통 붓글씨)', key: 'hygungsuh', category: 'serif' },
                'h2mjre.ttf': { label: 'HY중명조 (명조체)', key: 'hymyungjo', category: 'serif' },
                'gulim.ttc': { label: '굴림 / 돋움 (Gulim)', key: 'gulim', category: 'gothic' },
                'batang.ttc': { label: '바탕 / 명조 (Batang)', key: 'batang', category: 'serif' },
                'ngulim.ttf': { label: '새굴림 (NGulim)', key: 'ngulim', category: 'gothic' },
                'arial.ttf': { label: 'Arial (영문 전용, 한글 미지원)', key: 'arial', category: 'english' }
            };

            const installed = [];
            const seen = new Set();

            fontDirs.forEach(dir => {
                if (!dir || !fs.existsSync(dir)) return;
                try {
                    const files = fs.readdirSync(dir);
                    files.forEach(file => {
                        const lower = file.toLowerCase();
                        const ext = path.extname(lower);
                        if (['.ttf', '.ttc', '.otf'].includes(ext)) {
                            if (seen.has(lower)) return;
                            seen.add(lower);
                            const fullPath = path.join(dir, file);
                            const meta = fontMap[lower];
                            installed.push({
                                file: file,
                                lower: lower,
                                fullPath: fullPath,
                                label: meta ? meta.label : file,
                                key: meta ? meta.key : ('custom_' + lower),
                                isPreset: !!meta,
                                category: meta ? meta.category : 'other'
                            });
                        }
                    });
                } catch (e) {}
            });

            // 프리셋 폰트 우선 정렬
            installed.sort((a, b) => {
                if (a.isPreset && !b.isPreset) return -1;
                if (!a.isPreset && b.isPreset) return 1;
                return a.label.localeCompare(b.label, 'ko');
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, fonts: installed }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }

    // 1-2. 로컬 폰트 파일 브라우저 서빙 (프리뷰 캔버스 @font-face 지원)
    if (pathname === '/api/font-file' && req.method === 'GET') {
        let fontPath = parsedUrl.searchParams.get('path');
        const fontNameParam = parsedUrl.searchParams.get('name');
        if (!fontPath && fontNameParam) {
            const fontName = path.basename(fontNameParam);
            const winFont = path.join('C:\\Windows\\Fonts', fontName);
            if (fs.existsSync(winFont)) fontPath = winFont;
        }

        if (!fontPath || !fs.existsSync(fontPath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('폰트 파일을 찾을 수 없습니다.');
            return;
        }

        const ext = path.extname(fontPath).toLowerCase();
        let mime = 'application/octet-stream';
        if (ext === '.ttf') mime = 'font/ttf';
        else if (ext === '.otf') mime = 'font/otf';
        else if (ext === '.woff2') mime = 'font/woff2';
        else if (ext === '.ttc') mime = 'font/collection';

        res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(fontPath).pipe(res);
        return;
    }

    // 2. 렌더링 진행률 조회 (Polling / SSE 지원)
    if (pathname === '/api/render/progress' && req.method === 'GET') {
        if (renderState.isRendering && renderState.startTime > 0) {
            renderState.elapsedTime = formatElapsed(Date.now() - renderState.startTime);
        }
        // 결과물 스트리밍 URL 계산 (에디터 내부면 정적 경로, reels 등 외부면 /api/reels-file)
        if (renderState.outputFile) {
            const resolvedOut = path.resolve(ROOT_DIR, renderState.outputFile);
            const relToRoot = path.relative(ROOT_DIR, resolvedOut);
            if (relToRoot && !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
                renderState.outputUrl = '/' + relToRoot.replace(/\\/g, '/');
            } else {
                renderState.outputUrl = `/api/reels-file?path=${encodeURIComponent(resolvedOut)}`;
            }
        }
        // GIF 동시 저장 결과도 같은 방식으로 URL 을 계산해 준다
        if (renderState.gifFile) {
            const resolvedGif = path.resolve(ROOT_DIR, renderState.gifFile);
            const relGif = path.relative(ROOT_DIR, resolvedGif);
            if (relGif && !relGif.startsWith('..') && !path.isAbsolute(relGif)) {
                renderState.gifUrl = '/' + relGif.replace(/\\/g, '/');
            } else {
                renderState.gifUrl = `/api/reels-file?path=${encodeURIComponent(resolvedGif)}`;
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(renderState));
        return;
    }

    // 3. 미디어 파일 자동 업로드 및 동기화 (/api/upload?filename=...)
    if (pathname === '/api/upload' && req.method === 'POST') {
        const rawFilename = parsedUrl.searchParams.get('filename') || `media_${Date.now()}`;
        const filename = path.basename(decodeURIComponent(rawFilename));
        const sourceDir = path.join(ROOT_DIR, 'source');
        if (!fs.existsSync(sourceDir)) {
            fs.mkdirSync(sourceDir, { recursive: true });
        }
        const targetPath = path.join(sourceDir, filename);
        const fileStream = fs.createWriteStream(targetPath);

        req.pipe(fileStream);

        fileStream.on('finish', () => {
            let size = 0;
            try {
                size = fs.statSync(targetPath).size;
            } catch (e) {}

            const ext = path.extname(filename).toLowerCase();
            let mediaType = 'unknown';
            if (VIDEO_EXTS.has(ext)) mediaType = 'video';
            else if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg'].includes(ext)) mediaType = 'image';
            else if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(ext)) mediaType = 'audio';

            console.log(`[LookVideoEditor] 소스 파일 업로드 완료: ${targetPath} (${(size / 1024).toFixed(1)} KB, type: ${mediaType})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                localPath: targetPath,
                filename: filename,
                url: `/source/${encodeURIComponent(filename)}`,
                size: size,
                type: mediaType
            }));
        });

        fileStream.on('error', (err) => {
            console.error(`[LookVideoEditor] 소스 파일 업로드 실패:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message }));
        });
        return;
    }

    // 3-0. 소스 폴더(source/) 파일 목록 조회
    if (pathname === '/api/source/list' && req.method === 'GET') {
        const sourceDir = path.join(ROOT_DIR, 'source');
        if (!fs.existsSync(sourceDir)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files: [] }));
            return;
        }

        try {
            const files = fs.readdirSync(sourceDir)
                .map(f => {
                    const fp = path.join(sourceDir, f);
                    try {
                        const stat = fs.statSync(fp);
                        if (!stat.isFile()) return null;
                        const ext = path.extname(f).toLowerCase();
                        let type = 'unknown';
                        if (VIDEO_EXTS.has(ext)) type = 'video';
                        else if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) type = 'image';
                        else if (['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) type = 'audio';

                        return {
                            name: f,
                            localPath: fp,
                            url: `/source/${encodeURIComponent(f)}`,
                            size: stat.size,
                            type: type,
                            mtime: stat.mtimeMs
                        };
                    } catch (e) {
                        return null;
                    }
                })
                .filter(Boolean)
                .sort((a, b) => b.mtime - a.mtime);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // 3-0-1. 소스 폴더(source/) 파일 삭제/언로드
    if (pathname === '/api/source/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const filename = data.filename ? path.basename(data.filename) : null;
                if (!filename) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '파일명이 제공되지 않았습니다.' }));
                    return;
                }
                const targetPath = path.join(ROOT_DIR, 'source', filename);
                if (fs.existsSync(targetPath)) {
                    fs.unlinkSync(targetPath);
                    console.log(`[LookVideoEditor] 소스 파일 삭제 완료: ${targetPath}`);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, deleted: filename }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 3-1. 무료 음악 검색 관련 (Openverse CC0/퍼블릭 도메인)
    //      브라우저가 직접 외부 API 를 부르지 않고 이 서버를 거치게 해서
    //      레이트 리밋(분당 20회)을 한 곳에서 지키고 에러 처리를 통일한다.
    if (pathname === '/api/music/keywords' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keywords: getQuickKeywords(), rateLimit: getRateLimitInfo() }));
        return;
    }

    if (pathname === '/api/music/search' && req.method === 'GET') {
        const q = parsedUrl.searchParams.get('q') || '';
        const page = parseInt(parsedUrl.searchParams.get('page'), 10) || 1;
        const minDurationSec = parseFloat(parsedUrl.searchParams.get('min_duration')) || 0;
        const maxDurationSec = parseFloat(parsedUrl.searchParams.get('max_duration')) || 0;

        searchMusic({ q, page, minDurationSec, maxDurationSec })
            .then(data => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, ...data }));
            })
            .catch(err => {
                console.warn(`[LookVideoEditor] 음악 검색 실패 (${err.code || 'unknown'}): ${err.message}`);
                res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: err.code || 'unknown',
                    message: err.message,
                }));
            });
        return;
    }

    if (pathname === '/api/music/download' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let id = '';
            try {
                id = JSON.parse(body).id;      // 클라이언트는 id 만 보낸다 (URL 은 서버가 재조회)
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'invalid_body', message: '요청 형식이 올바르지 않습니다.' }));
                return;
            }

            const sourceDir = path.join(ROOT_DIR, 'source');
            downloadMusic({ id, sourceDir })
                .then(result => {
                    console.log(`[LookVideoEditor] 음악 저장 완료: ${result.filename} (${Math.round(result.bytes / 1024)}KB, ${result.durationSec.toFixed(1)}초)`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                })
                .catch(err => {
                    console.warn(`[LookVideoEditor] 음악 다운로드 실패 (${err.code || 'unknown'}): ${err.message}`);
                    res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: err.code || 'unknown',
                        message: err.message,
                    }));
                });
        });
        return;
    }

    // 4. 렌더링 시작
    if (pathname === '/api/render' && req.method === 'POST') {
        if (renderState.isRendering) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '이미 다른 렌더링 작업이 진행 중입니다.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { command, outputFile, totalDuration, fps, rawInputs, filterComplex, mappedVideo, mappedAudio, encoder } = data;

                if (!command && !rawInputs) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'FFmpeg 렌더링 데이터가 제공되지 않았습니다.' }));
                    return;
                }

                let targetOutputFile = outputFile || path.join('output', `rendered_${Date.now()}.mp4`);
                if (typeof targetOutputFile === 'string' && (targetOutputFile.startsWith('..\\samples') || targetOutputFile.startsWith('../samples') || targetOutputFile.startsWith('samples/') || targetOutputFile.startsWith('samples\\'))) {
                    const relPart = targetOutputFile.replace(/^(\.\.[\\/])?samples[\\/]/, '');
                    targetOutputFile = path.join(getWorkDir(), relPart);
                }

                // 상태 초기화
                renderState = {
                    isRendering: true,
                    progress: 0,
                    currentTime: "00:00:00.00",
                    totalDuration: totalDuration || 10,
                    fps: String(fps || 30),
                    speed: "0x",
                    status: "rendering",
                    error: null,
                    outputFile: targetOutputFile,
                    startTime: Date.now(),
                    elapsedTime: "00:00"
                };

                // 출력 경로 검증 (프로젝트 루트 또는 현재 작업 폴더 허용)
                const resolvedOutput = path.resolve(ROOT_DIR, renderState.outputFile);
                const currentWorkDir = getWorkDir();
                const outputAllowed = [PROJECT_ROOT, ROOT_DIR, currentWorkDir].some(root =>
                    resolvedOutput === root || resolvedOutput.startsWith(root + path.sep)
                );
                if (!outputAllowed) {
                    renderState.isRendering = false;
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '출력 경로가 허용 범위를 벗어났습니다.' }));
                    return;
                }

                // 출력 경로의 상위 디렉터리 확인 및 생성 (samples/{폴더}/reels 저장 지원)
                const outputParent = path.dirname(resolvedOutput);
                if (!fs.existsSync(outputParent)) {
                    fs.mkdirSync(outputParent, { recursive: true });
                }

                const ffmpegBin = getFFmpegBinary();
                console.log(`[LookVideoEditor] 렌더링 시작: ${ffmpegBin}`);
                console.log(`[LookVideoEditor] 출력 파일: ${renderState.outputFile}`);

                let child;
                const tempFilterPath = path.join(ROOT_DIR, `temp_filter_${Date.now()}.txt`);

                if (rawInputs && filterComplex && mappedVideo && mappedAudio) {
                    // 1. 최적의 안전 방식: -filter_complex_script 를 사용한 직접 spawn (Windows 쉘/따옴표 에러 100% 방지)
                    const filterScriptContent = filterComplex.join(";\n");
                    fs.writeFileSync(tempFilterPath, filterScriptContent, 'utf8');

                    const args = ['-y'];
                    rawInputs.forEach(inp => {
                        // 반복 재생: -stream_loop 는 -i 앞에 오는 입력 옵션이어야 한다.
                        // 유한 횟수(loop)를 쓰므로 -t 가 어떤 이유로 무시돼도 무한 읽기가 되지 않는다.
                        if (inp.loop > 0) args.push('-stream_loop', String(inp.loop));
                        if (inp.ss) args.push('-ss', inp.ss);
                        if (inp.t) args.push('-t', inp.t);
                        args.push('-i', inp.path);
                    });

                    args.push('-filter_complex_script', tempFilterPath);
                    args.push('-map', mappedVideo);
                    args.push('-map', mappedAudio);
                    args.push('-t', parseFloat(totalDuration).toFixed(2));

                    if (encoder === 'h264_nvenc') {
                        args.push('-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '20');
                    } else {
                        args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20');
                    }

                    args.push('-pix_fmt', 'yuv420p', '-r', String(fps || 30));
                    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '44100');
                    args.push(path.resolve(ROOT_DIR, renderState.outputFile));

                    console.log(`[LookVideoEditor] FFmpeg 바이너리 직접 실행: ${ffmpegBin}`);
                    console.log(`[LookVideoEditor] Arguments count: ${args.length}`);

                    child = spawn(ffmpegBin, args, {
                        cwd: ROOT_DIR,
                        windowsHide: true
                    });
                } else {
                    // 폴백: exec 방식
                    let actualCmd = command;
                    if (actualCmd.startsWith('ffmpeg ')) {
                        actualCmd = `"${ffmpegBin}" ` + actualCmd.substring(7);
                    }
                    child = exec(actualCmd, {
                        cwd: ROOT_DIR,
                        windowsHide: true,
                        maxBuffer: 1024 * 1024 * 50
                    });
                }

                registerProcess(child);

                let lastStderr = '';

                child.stderr.on('data', (chunk) => {
                    const str = chunk.toString('utf8');
                    lastStderr += str;
                    if (lastStderr.length > 5000) lastStderr = lastStderr.slice(-5000);

                    // FFmpeg 진행 정보 파싱 (예: frame=  120 fps= 60 q=20.0 size=    1024kB time=00:00:04.00 bitrate=2097.2kbits/s speed=2.1x)
                    const timeMatch = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
                    const fpsMatch = str.match(/fps=\s*([\d\.]+)/);
                    const speedMatch = str.match(/speed=\s*([\d\.]+x)/);

                    if (timeMatch) {
                        renderState.currentTime = timeMatch[1];
                        const currentSec = parseTimeToSeconds(timeMatch[1]);
                        if (renderState.totalDuration > 0) {
                            renderState.progress = Math.min(99.5, parseFloat(((currentSec / renderState.totalDuration) * 100).toFixed(1)));
                        }
                    }
                    if (fpsMatch) renderState.fps = fpsMatch[1];
                    if (speedMatch) renderState.speed = speedMatch[1];
                });

                child.on('close', (code) => {
                    try {
                        if (fs.existsSync(tempFilterPath)) fs.unlinkSync(tempFilterPath);
                    } catch (e) {}

                    if (renderState.status === 'cancelled') {
                        console.log('[LookVideoEditor] 렌더링이 사용자에 의해 취소되었습니다.');
                        return;
                    }

                    if (code === 0) {
                        renderState.isRendering = false;
                        renderState.progress = 100;
                        renderState.status = 'completed';
                        renderState.elapsedTime = formatElapsed(Date.now() - renderState.startTime);
                        console.log(`[LookVideoEditor] 렌더링 성공 완료! (${renderState.elapsedTime})`);
                    } else {
                        renderState.isRendering = false;
                        renderState.status = 'error';
                        renderState.error = `FFmpeg 종료 코드 ${code}\n${lastStderr.slice(-800)}`;
                        console.error(`[LookVideoEditor] 렌더링 실패: 코드 ${code}`);
                    }
                });

                child.on('error', (err) => {
                    try {
                        if (fs.existsSync(tempFilterPath)) fs.unlinkSync(tempFilterPath);
                    } catch (e) {}
                    renderState.isRendering = false;
                    renderState.status = 'error';
                    renderState.error = err.message;
                    console.error('[LookVideoEditor] FFmpeg 프로세스 에러:', err);
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'started', outputFile: renderState.outputFile }));

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 4. 렌더링 취소 (WebP 병렬 프로브까지 모두 종료)
    if (pathname === '/api/render/cancel' && req.method === 'POST') {
        const killed = killAllProcesses();
        if (killed > 0 || renderState.isRendering) {
            renderState.status = 'cancelled';
            renderState.isRendering = false;
            pendingWebp = null;
            pendingGif = null;
            // 확인 대기 중이던 보류본까지 버린다 (사용자가 작업 자체를 중단했으므로)
            cleanupAllPending();
            // 죽인 프로세스가 남긴 임시 폴더 정리 (exportWebp 의 catch 도 시도하지만
            // 프로세스가 죽어 reject 가 늦게 도착할 수 있어 여기서도 처리한다)
            const swept = cleanupOrphanTemps(WEBP_TEMP_ROOT);
            scheduleTempSweep();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'cancelled', killed, swept }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'no_active_render' }));
        }
        return;
    }

    // 4-B. 애니메이션 WebP 내보내기 시작 (목표 용량 보장)
    if (pathname === '/api/render/webp' && req.method === 'POST') {
        if (renderState.isRendering) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '이미 다른 렌더링 작업이 진행 중입니다.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let data;
            try {
                data = JSON.parse(body);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '요청 본문을 해석할 수 없습니다.' }));
                return;
            }

            const {
                rawInputs, filterComplex, mappedVideo, mappedAudio,
                rangeStart = 0, rangeDuration = 5, fps = 20,
                targetMB = 3, outputWidth = 1080, outputHeight = 1920,
                outputFile,
                gifEnabled = false, gifTargetMB = 5, gifDuration = 0
            } = data;

            if (!rawInputs || !filterComplex || !mappedVideo || !outputFile) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'WebP 내보내기 파라미터가 부족합니다.' }));
                return;
            }
            if (!(rangeDuration > 0)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'WebP 구간 길이가 올바르지 않습니다.' }));
                return;
            }

            let targetOutputFile = outputFile;
            if (typeof targetOutputFile === 'string' && (targetOutputFile.startsWith('..\\samples') || targetOutputFile.startsWith('../samples') || targetOutputFile.startsWith('samples/') || targetOutputFile.startsWith('samples\\'))) {
                const relPart = targetOutputFile.replace(/^(\.\.[\\/])?samples[\\/]/, '');
                targetOutputFile = path.join(getWorkDir(), relPart);
            }

            // 출력 경로 검증 (프로젝트 루트 또는 현재 작업 폴더 허용)
            const resolvedOutput = path.resolve(ROOT_DIR, targetOutputFile);
            const currentWorkDir = getWorkDir();
            const outputAllowed = [PROJECT_ROOT, ROOT_DIR, currentWorkDir].some(root =>
                resolvedOutput === root || resolvedOutput.startsWith(root + path.sep)
            );
            if (!outputAllowed) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '출력 경로가 허용 범위를 벗어났습니다.' }));
                return;
            }

            startWebpExport({
                rawInputs, filterComplex, mappedVideo, mappedAudio,
                rangeStart, rangeDuration, fps,
                targetBytes: Math.round(targetMB * 1024 * 1024),
                outputWidth, outputHeight, outputFile: targetOutputFile,
                mode: 'initial',
                gifEnabled: !!gifEnabled,
                gifTargetBytes: Math.round(Math.max(0.5, Number(gifTargetMB) || 5) * 1024 * 1024),
                gifMode: 'initial',
                gifDuration: Math.max(0, Number(gifDuration) || 0)
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'started', outputFile }));
        });
        return;
    }

    // 4-C. 해상도 하향 확인 응답 — 보관된 중간본을 재사용해 이어서 진행한다
    if (pathname === '/api/render/webp/confirm' && req.method === 'POST') {
        if (renderState.isRendering) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '이미 다른 렌더링 작업이 진행 중입니다.' }));
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let data;
            try {
                data = JSON.parse(body);
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '요청 본문을 해석할 수 없습니다.' }));
                return;
            }

            const { action, width, height, target } = data;

            // GIF 단계 확인 — webP 는 이미 저장됐고 GIF 만 이어서 진행한다
            if (target === 'gif') {
                if (!pendingGif) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'GIF 확인을 기다리는 작업이 없습니다. 처음부터 다시 시도해 주세요.' }));
                    return;
                }
                const gifBase = pendingGif;
                pendingGif = null;

                // GIF 는 "가장 낮은 설정으로 저장(floor)" 또는 "GIF 건너뛰기(skip)" 두 갈래만 있다
                if (action === 'skip') {
                    // 부분 후보 파일과 중간본을 정리하고 webP 결과만 남긴다
                    cleanupOrphanTemps(WEBP_TEMP_ROOT);
                    scheduleTempSweep();
                    renderState.isRendering = false;
                    renderState.status = 'completed';
                    renderState.progress = 100;
                    renderState.elapsedTime = formatElapsed(Date.now() - renderState.startTime);
                    renderState.gif = Object.assign(renderState.gif || {}, {
                        phase: 'skipped',
                        targetBytes: gifBase.targetBytes
                    });
                    console.log('[LookVideoEditor] GIF 건너뜀 — webP 결과만 저장');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'skipped' }));
                    return;
                }
                if (action !== 'floor') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'GIF 는 floor 또는 skip 만 허용됩니다.' }));
                    return;
                }

                const gifTargetBytes = gifBase.targetBytes;

                renderState = Object.assign({}, renderState, {
                    isRendering: true,
                    status: 'rendering',
                    startTime: Date.now(),
                    error: null,
                    // 확인창에서 progress 가 100 이었으므로 되돌려 놓는다(단조 증가 가드 때문에 필요)
                    progress: Math.min(renderState.progress || 0, 80)
                });

                exportWebp({
                    ffmpegBin: getFFmpegBinary(),
                    rawInputs: [],
                    filterComplex: null,
                    rangeStart: 0,
                    rangeDuration: renderState.totalDuration || 0,
                    fps: Number(renderState.fps) || 20,
                    targetBytes: 0,
                    maxWidth: 0,
                    maxHeight: 0,
                    outputPath: gifBase.outputFile ? path.resolve(ROOT_DIR, gifBase.outputFile) : '',
                    tempRoot: WEBP_TEMP_ROOT,
                    mode: 'gif-resume',
                    reuseToken: gifBase.token,
                    gif: {
                        enabled: true,
                        targetBytes: gifTargetBytes,
                        outputPath: gifBase.gifOutputPath,
                        mode: 'accept-floor',
                        sourceFps: gifBase.sourceFps,
                        duration: gifBase.duration || 0,
                        maxWidth: gifBase.outputWidth,
                        maxHeight: gifBase.outputHeight
                    }
                }, {
                    registerProcess,
                    onProgress: updateWebpProgress
                })
                .then((result) => {
                    renderState.isRendering = false;
                    renderState.elapsedTime = formatElapsed(Date.now() - renderState.startTime);
                    if (result.status === 'needs_confirm') {
                        renderState.status = 'needs_confirm';
                        renderState.gif = Object.assign(renderState.gif || {}, {
                            phase: 'needs_confirm',
                            token: result.gif.token,
                            floorSizeBytes: result.gif.floorSizeBytes,
                            targetBytes: result.gif.targetBytes,
                            width: result.gif.width,
                            height: result.gif.height,
                            fps: result.gif.fps,
                            colors: result.gif.colors
                        });
                        pendingGif = Object.assign({}, gifBase, { token: result.gif.token });
                        return;
                    }
                    finishGif(result.gif);
                })
                .catch((err) => {
                    cleanupOrphanTemps(WEBP_TEMP_ROOT);
                    scheduleTempSweep();
                    if (renderState.status === 'cancelled') return;
                    renderState.isRendering = false;
                    renderState.status = 'error';
                    renderState.error = err.message;
                    console.error('[LookVideoEditor] GIF 재개 실패:', err.message);
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'started' }));
                return;
            }

            if (!pendingWebp) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '확인을 기다리는 작업이 없습니다. 처음부터 다시 시도해 주세요.' }));
                return;
            }

            const base = pendingWebp;
            pendingWebp = null;

            if (action === 'floor') {
                // 하향 거부 — 품질 하한으로 확정하고 초과를 감수
                startWebpExport(Object.assign({}, base, {
                    mode: 'accept-floor',
                    reuseToken: base.token
                }));
            } else {
                if (!(width > 0 && height > 0)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '승인할 해상도가 올바르지 않습니다.' }));
                    return;
                }
                startWebpExport(Object.assign({}, base, {
                    mode: 'accept-resolution',
                    reuseToken: base.token,
                    forcedWidth: parseInt(width, 10),
                    forcedHeight: parseInt(height, 10)
                }));
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'started' }));
        });
        return;
    }

    // 5. 저장 폴더 열기 (Windows Explorer)
    if (pathname === '/api/open-output' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let targetFile = renderState.outputFile;
            try {
                if (body) {
                    const parsed = JSON.parse(body);
                    if (parsed.outputFile) targetFile = parsed.outputFile;
                }
            } catch (e) {}

            const outputDir = path.resolve(ROOT_DIR, 'output');
            
            // 최신 파일 탐색 폴백
            if ((!targetFile || !fs.existsSync(path.resolve(ROOT_DIR, targetFile))) && fs.existsSync(outputDir)) {
                const files = fs.readdirSync(outputDir)
                    .filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.webp'))
                    .map(f => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtime.getTime() }))
                    .sort((a, b) => b.time - a.time);
                if (files.length > 0) targetFile = path.join('output', files[0].name);
            }

            const fullPath = targetFile ? path.resolve(ROOT_DIR, targetFile) : outputDir;
            const targetDir = (fullPath && fs.existsSync(fullPath))
                ? (fs.statSync(fullPath).isDirectory() ? fullPath : path.dirname(fullPath))
                : outputDir;

            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            console.log(`[LookVideoEditor] 저장 폴더 열기 실행: ${targetDir}`);

            // Windows 탐색기에서 저장 폴더 바로 열기 (안정적 100% 보장)
            spawn('explorer.exe', [targetDir], { detached: true, stdio: 'ignore' }).unref();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'opened', path: targetDir }));
        });
        return;
    }

    // 6. 결과 영상 파일 직접 재생 열기
    if (pathname === '/api/open-file' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            let targetFile = renderState.outputFile;
            try {
                if (body) {
                    const parsed = JSON.parse(body);
                    if (parsed.outputFile) targetFile = parsed.outputFile;
                }
            } catch (e) {}

            const outputDir = path.resolve(ROOT_DIR, 'output');
            
            // 최신 파일 탐색 폴백
            if ((!targetFile || !fs.existsSync(path.resolve(ROOT_DIR, targetFile))) && fs.existsSync(outputDir)) {
                const files = fs.readdirSync(outputDir)
                    .filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.webp'))
                    .map(f => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtime.getTime() }))
                    .sort((a, b) => b.time - a.time);
                if (files.length > 0) targetFile = path.join('output', files[0].name);
            }

            const fullPath = targetFile ? path.resolve(ROOT_DIR, targetFile) : null;
            console.log(`[LookVideoEditor] 결과 영상 재생 요청: ${fullPath}`);

            if (fullPath && fs.existsSync(fullPath)) {
                if (path.extname(fullPath).toLowerCase() === '.webp') {
                    // 애니메이션 WebP 는 Windows 사진 앱이 첫 프레임만 보여줄 수 있으므로
                    // 기본 브라우저로 우리 서버 URL 을 연다 (애니메이션 재생 보장).
                    const url = `http://localhost:${PORT}/api/reels-file?path=${encodeURIComponent(fullPath)}`;
                    spawn('cmd.exe', ['/c', 'start', '""', `"${url}"`], { detached: true, stdio: 'ignore' }).unref();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'opened', file: fullPath, url }));
                } else {
                    // Windows 기본 미디어 플레이어로 포그라운드 실행 (경로 따옴표 처리로 공백 안전)
                    spawn('cmd.exe', ['/c', 'start', '""', `"${fullPath}"`], { detached: true, stdio: 'ignore' }).unref();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'opened', file: fullPath }));
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '파일을 찾을 수 없습니다.' }));
            }
        });
        return;
    }

    function makeReelItem(filePath, product = '', origin = 'external') {
        const name = path.basename(filePath);
        let size = 0;
        let mtime = Date.now();
        try {
            const stat = fs.statSync(filePath);
            size = stat.size;
            mtime = stat.mtime.getTime();
        } catch (e) {}
        const base = name.slice(0, name.lastIndexOf('.'));
        const posterPath = path.join(path.dirname(filePath), `${base}_thumb.jpg`);
        const poster = fs.existsSync(posterPath) ? posterPath : null;
        return {
            name,
            source: filePath,
            product,
            origin,
            url: `/api/reels-file?path=${encodeURIComponent(filePath)}`,
            poster: poster ? `/api/reels-file?path=${encodeURIComponent(poster)}` : null,
            size,
            mtime
        };
    }

    function scanFolderForReels(folderPath, maxDepth = 2) {
        const results = [];
        const seen = new Set();
        function walk(dir, depth) {
            if (depth > maxDepth) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === '추출사진') continue;
                        walk(fullPath, depth + 1);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (VIDEO_EXTS.has(ext)) {
                            const key = fullPath.toLowerCase();
                            if (!seen.has(key)) {
                                seen.add(key);
                                results.push(makeReelItem(fullPath, folderPath, 'external'));
                            }
                        }
                    }
                }
            } catch (e) {}
        }
        walk(folderPath, 0);
        return results;
    }

    // 7. 릴스 목록 조회 (vTonSales 릴스 저장 폴더 및 외부 등록 폴더 스캔)
    if (pathname === '/api/reels/list' && req.method === 'GET') {
        const reels = [];
        const seen = new Set();

        const addReel = (filePath, product, origin) => {
            const key = filePath.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            reels.push(makeReelItem(filePath, product, origin));
        };

        try {
            // 1) work_dir/{상품}/reels + work_dir/{상품}/lookbook_reels (작업 폴더 동적 스캔)
            const workDir = getWorkDir();
            const folders = new Map(); // 폴더명 -> { name, displayName, category, count }
            if (fs.existsSync(workDir)) {
                let subDirs = [];
                try {
                    subDirs = fs.readdirSync(workDir).filter(f => {
                        try { return fs.statSync(path.join(workDir, f)).isDirectory(); } catch (e) { return false; }
                    });
                } catch (e) {}

                // 단일 상품 폴더 자체인지 다중 상품 부모 폴더인지 검사
                const hasDirectReels = fs.existsSync(path.join(workDir, 'reels')) || fs.existsSync(path.join(workDir, 'lookbook_reels')) || fs.existsSync(path.join(workDir, 'spec.json'));
                const scanTargets = hasDirectReels
                    ? [{ name: path.basename(workDir) || 'current', dirPath: workDir }]
                    : subDirs.map(d => ({ name: d, dirPath: path.join(workDir, d) }));

                for (const target of scanTargets) {
                    const productDir = target.name;
                    const productPath = target.dirPath;
                    let count = 0;
                    for (const sub of ['reels', 'lookbook_reels']) {
                        const subPath = path.join(productPath, sub);
                        if (!fs.existsSync(subPath)) continue;
                        for (const f of fs.readdirSync(subPath)) {
                            if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
                            const filePath = path.join(subPath, f);
                            if (fs.statSync(filePath).isFile()) {
                                addReel(filePath, productDir, 'work_dir');
                                count++;
                            }
                        }
                    }
                    let displayName = productDir;
                    let category = '';
                    try {
                        const specPath = path.join(productPath, 'spec.json');
                        if (fs.existsSync(specPath)) {
                            const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
                            if (spec && spec.name) displayName = spec.name;
                            if (spec && spec.category) category = spec.category;
                        }
                    } catch (e) {}
                    folders.set(productDir, { name: productDir, displayName, category, count });
                }
            }
            // 2) 생성기 outputs/reels 2곳
            for (const outDir of [
                path.join(PROJECT_ROOT, 'lookbook_video_generator', 'outputs', 'reels'),
                path.join(PROJECT_ROOT, 'lookbook_video_api_generator', 'outputs', 'reels')
            ]) {
                if (!fs.existsSync(outDir)) continue;
                for (const f of fs.readdirSync(outDir)) {
                    if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
                    const filePath = path.join(outDir, f);
                    if (fs.statSync(filePath).isFile()) {
                        addReel(filePath, '', outDir.includes('api') ? 'lookbook_api_generator' : 'lookbook_generator');
                    }
                }
            }

            // 3) 외부 등록 폴더 스캔
            const extFolders = getExternalFolders();
            for (const extDir of extFolders) {
                if (!fs.existsSync(extDir)) continue;
                let extCount = 0;
                try {
                    const files = fs.readdirSync(extDir);
                    for (const f of files) {
                        if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
                        const filePath = path.join(extDir, f);
                        if (fs.statSync(filePath).isFile()) {
                            addReel(filePath, extDir, 'external');
                            extCount++;
                        }
                    }
                    folders.set(extDir, {
                        name: extDir,
                        displayName: `[외부] ${path.basename(extDir)}`,
                        category: '외부 폴더',
                        count: extCount,
                        isExternal: true
                    });
                } catch (e) {}
            }

            reels.sort((a, b) => b.mtime - a.mtime);
            const folderList = Array.from(folders.values()).sort((a, b) => {
                if (a.isExternal && !b.isExternal) return -1;
                if (!a.isExternal && b.isExternal) return 1;
                return a.name.localeCompare(b.name);
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, folders: folderList, reels }));
            return;
        } catch (e) {
            console.error('[LookVideoEditor] 릴스 스캔 실패:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, folders: [], reels: [] }));
            return;
        }
    }

    // 8. 릴스/외부 파일 서빙 (로컬 PC의 모든 미디어 파일 지원, HTTP 206 Range 지원)
    if (pathname === '/api/reels-file' && req.method === 'GET') {
        const rawPath = parsedUrl.searchParams.get('path');
        if (!rawPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'path required' }));
            return;
        }
        let targetPath;
        try {
            targetPath = path.resolve(decodeURIComponent(rawPath));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid path' }));
            return;
        }

        const ext = path.extname(targetPath).toLowerCase();
        const isMedia = VIDEO_EXTS.has(ext) || Boolean(MIME_TYPES[ext]);
        if (!isMedia) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: not a media file' }));
            return;
        }

        fs.stat(targetPath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            const range = req.headers.range;
            if (range && (VIDEO_EXTS.has(ext) || ext === '.mp3' || ext === '.wav')) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
                const chunksize = (end - start) + 1;
                const file = fs.createReadStream(targetPath, { start, end });
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${stats.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': contentType,
                });
                file.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': stats.size,
                    'Content-Type': contentType,
                    'Accept-Ranges': 'bytes'
                });
                fs.createReadStream(targetPath).pipe(res);
            }
        });
        return;
    }

    // 9. Windows 파일 선택 다이얼로그 (외부 동영상 파일 선택)
    if (pathname === '/api/dialog/open-video' && req.method === 'POST') {
        try {
            const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles(); $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Title = '외부 동영상 파일 선택'; $f.Filter = '동영상 파일 (*.mp4;*.mov;*.webm;*.avi;*.mkv;*.m4v)|*.mp4;*.mov;*.webm;*.avi;*.mkv;*.m4v|모든 파일 (*.*)|*.*'; $f.Multiselect = $true; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileNames -join [char]10 }`;
            const output = await runPowerShell(script, 45000);
            const filePaths = output ? output.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
            const results = [];
            for (const fp of filePaths) {
                if (fs.existsSync(fp)) {
                    saveExternalFolder(path.dirname(fp));
                    results.push(makeReelItem(fp, path.dirname(fp), 'external'));
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, files: results }));
        } catch (e) {
            console.error('[LookVideoEditor] 파일 다이얼로그 실패:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // 10. Windows 폴더 선택 다이얼로그 (외부 동영상 폴더 선택)
    if (pathname === '/api/dialog/open-folder' && req.method === 'POST') {
        try {
            const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles(); $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '동영상이 있는 폴더를 선택하세요'; $f.ShowNewFolderButton = $false; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }`;
            const selectedFolder = await runPowerShell(script, 45000);
            if (selectedFolder && fs.existsSync(selectedFolder)) {
                saveExternalFolder(selectedFolder);
                const results = scanFolderForReels(selectedFolder, 1);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    folder: selectedFolder,
                    folderName: path.basename(selectedFolder),
                    files: results
                }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, cancelled: true, files: [] }));
            }
        } catch (e) {
            console.error('[LookVideoEditor] 폴더 다이얼로그 실패:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // 11. 외부 폴더 경로 직접 스캔 (/api/external-videos/scan)
    if (pathname === '/api/external-videos/scan' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const folderPath = data.folderPath ? path.resolve(data.folderPath) : null;
                if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '유효한 폴더 경로가 아닙니다.' }));
                    return;
                }
                saveExternalFolder(folderPath);
                const results = scanFolderForReels(folderPath, 1);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    folder: folderPath,
                    folderName: path.basename(folderPath),
                    files: results
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 12. 외부 파일 경로 배열 검증 및 추가 (/api/external-videos/files)
    if (pathname === '/api/external-videos/files' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const filePaths = Array.isArray(data.filePaths) ? data.filePaths : [];
                const results = [];
                for (const fp of filePaths) {
                    if (typeof fp === 'string' && fs.existsSync(fp)) {
                        const resolved = path.resolve(fp);
                        if (fs.statSync(resolved).isFile() && VIDEO_EXTS.has(path.extname(resolved).toLowerCase())) {
                            saveExternalFolder(path.dirname(resolved));
                            results.push(makeReelItem(resolved, path.dirname(resolved), 'external'));
                        }
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, files: results }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 13. 타임라인 장면 사진 추출 및 저장 (/api/extract-frame)
    if (pathname === '/api/extract-frame' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const { videoPath, timestamp = 0, rotation = 0, canvasData, clipName } = data;

                let resolvedVideoPath = null;
                if (videoPath) {
                    try {
                        const p = path.resolve(videoPath);
                        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                            resolvedVideoPath = p;
                        }
                    } catch (e) {}
                }

                // 저장 대상 기본 폴더 결정:
                // 1순위: 현재 설정된 기본 작업 폴더 (Work Dir)
                // 2순위: 클라이언트 지정 폴더 (targetDir)
                // 3순위: 동영상 원본 폴더 (resolvedVideoPath)
                // 4순위: 서버 output 폴더
                const currentWorkDir = getWorkDir();
                let baseDir;
                if (currentWorkDir && fs.existsSync(currentWorkDir)) {
                    baseDir = currentWorkDir;
                } else if (data.targetDir && fs.existsSync(data.targetDir)) {
                    baseDir = path.resolve(data.targetDir);
                } else if (resolvedVideoPath) {
                    baseDir = path.dirname(resolvedVideoPath);
                } else {
                    baseDir = path.join(ROOT_DIR, 'output');
                }

                // 현재 작업 폴더 하위에 '추출사진' 폴더 생성 및 저장
                const extractDir = path.join(baseDir, '추출사진');
                if (!fs.existsSync(extractDir)) {
                    fs.mkdirSync(extractDir, { recursive: true });
                }

                // 파일명 생성: {영상명}_{분m초s밀리초}.png
                const sec = Math.max(0, parseFloat(timestamp) || 0);
                const m = Math.floor(sec / 60);
                const s = Math.floor(sec % 60);
                const ms = Math.floor((sec % 1) * 100);
                const timeStr = `${m.toString().padStart(2, '0')}m${s.toString().padStart(2, '0')}s${ms.toString().padStart(2, '0')}`;

                let rawBaseName = resolvedVideoPath
                    ? path.basename(resolvedVideoPath, path.extname(resolvedVideoPath))
                    : (clipName || 'scene');
                rawBaseName = rawBaseName.replace(/[\/\\:*?"<>|]/g, '_');

                let targetFilename = `${rawBaseName}_${timeStr}.png`;
                let outputPath = path.join(extractDir, targetFilename);
                let counter = 1;
                while (fs.existsSync(outputPath)) {
                    targetFilename = `${rawBaseName}_${timeStr}_${counter}.png`;
                    outputPath = path.join(extractDir, targetFilename);
                    counter++;
                }

                // 1순위: FFmpeg를 통한 원본 고화질 프레임 무손실 추출
                if (resolvedVideoPath) {
                    const ffmpegBin = getFFmpegBinary();
                    const args = ['-y', '-ss', sec.toFixed(3), '-i', resolvedVideoPath];

                    const rot = parseInt(rotation, 10) || 0;
                    const vf = [];
                    if (rot === 90) vf.push('transpose=1');
                    else if (rot === 180) vf.push('transpose=2,transpose=2');
                    else if (rot === 270) vf.push('transpose=2');

                    if (vf.length > 0) {
                        args.push('-vf', vf.join(','));
                    }
                    args.push('-vframes', '1', '-q:v', '2', outputPath);

                    console.log(`[LookVideoEditor] 사진 추출 시작: ${ffmpegBin} ${args.join(' ')}`);

                    const child = spawn(ffmpegBin, args);
                    let stderr = '';
                    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

                    child.on('close', code => {
                        if (code === 0 && fs.existsSync(outputPath)) {
                            console.log(`[LookVideoEditor] 사진 추출 성공: ${outputPath}`);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                success: true,
                                filename: targetFilename,
                                savedPath: outputPath,
                                folder: extractDir,
                                url: `/api/reels-file?path=${encodeURIComponent(outputPath)}`
                            }));
                        } else {
                            console.warn(`[LookVideoEditor] FFmpeg 사진 추출 실패(코드 ${code}), Canvas 폴백 시도:`, stderr.slice(-300));
                            if (canvasData && canvasData.startsWith('data:image/')) {
                                try {
                                    const base64Data = canvasData.replace(/^data:image\/\w+;base64,/, '');
                                    fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
                                    res.writeHead(200, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({
                                        success: true,
                                        filename: targetFilename,
                                        savedPath: outputPath,
                                        folder: extractDir,
                                        url: `/api/reels-file?path=${encodeURIComponent(outputPath)}`,
                                        fallback: true
                                    }));
                                    return;
                                } catch (err) {
                                    res.writeHead(500, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({ success: false, error: err.message }));
                                    return;
                                }
                            }
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: `FFmpeg failed with code ${code}` }));
                        }
                    });

                    child.on('error', err => {
                        console.warn('[LookVideoEditor] FFmpeg 실행 에러, Canvas 폴백 시도:', err.message);
                        if (canvasData && canvasData.startsWith('data:image/')) {
                            try {
                                const base64Data = canvasData.replace(/^data:image\/\w+;base64,/, '');
                                fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    success: true,
                                    filename: targetFilename,
                                    savedPath: outputPath,
                                    folder: extractDir,
                                    url: `/api/reels-file?path=${encodeURIComponent(outputPath)}`,
                                    fallback: true
                                }));
                                return;
                            } catch (writeErr) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: writeErr.message }));
                                return;
                            }
                        }
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: err.message }));
                    });
                } else if (canvasData && canvasData.startsWith('data:image/')) {
                    // 2순위: 캔버스 데이터로 직접 저장
                    try {
                        const base64Data = canvasData.replace(/^data:image\/\w+;base64,/, '');
                        fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
                        console.log(`[LookVideoEditor] Canvas 사진 추출 저장 완료: ${outputPath}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            filename: targetFilename,
                            savedPath: outputPath,
                            folder: extractDir,
                            url: `/api/reels-file?path=${encodeURIComponent(outputPath)}`
                        }));
                    } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: err.message }));
                    }
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '유효한 비디오 경로 또는 캔버스 이미지가 없습니다.' }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // 14. 추출된 사진 파일 탐색기에서 선택 (/api/open-extracted-photo)
    if (pathname === '/api/open-extracted-photo' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const filePath = data.path ? path.resolve(data.path) : null;
                if (filePath && fs.existsSync(filePath)) {
                    spawn('explorer.exe', [`/select,${filePath}`], { detached: true, stdio: 'ignore' }).unref();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, opened: filePath }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '파일을 찾을 수 없습니다.' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 15. 추출사진 폴더 탐색기로 열기 (/api/open-extract-folder)
    if (pathname === '/api/open-extract-folder' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                let folderPath = data.folder ? path.resolve(data.folder) : (data.path ? path.dirname(path.resolve(data.path)) : null);
                if (!folderPath || !fs.existsSync(folderPath)) {
                    const fallbackDir = path.join(getWorkDir(), '추출사진');
                    if (fs.existsSync(fallbackDir)) {
                        folderPath = fallbackDir;
                    }
                }
                if (folderPath && fs.existsSync(folderPath)) {
                    spawn('explorer.exe', [folderPath], { detached: true, stdio: 'ignore' }).unref();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, opened: folderPath }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '폴더를 찾을 수 없습니다.' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // 16. 비디오에서 오디오 분리 및 추출 (/api/audio/extract)
    if (pathname === '/api/audio/extract' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const { videoPath, filename } = data;

                let resolvedVideoPath = null;
                if (videoPath) {
                    try {
                        const p = path.resolve(videoPath);
                        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                            resolvedVideoPath = p;
                        }
                    } catch (e) {}
                }

                // source 폴더 또는 ROOT_DIR에서 파일명으로 탐색
                if (!resolvedVideoPath && filename) {
                    const candidateInSource = path.join(ROOT_DIR, 'source', filename);
                    if (fs.existsSync(candidateInSource)) {
                        resolvedVideoPath = candidateInSource;
                    } else {
                        const candidateInRoot = path.join(ROOT_DIR, filename);
                        if (fs.existsSync(candidateInRoot)) {
                            resolvedVideoPath = candidateInRoot;
                        }
                    }
                }

                if (!resolvedVideoPath) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: '유효한 비디오 파일을 찾을 수 없습니다.' }));
                    return;
                }

                // 추출 오디오 파일 저장 위치: source 폴더
                const sourceDir = path.join(ROOT_DIR, 'source');
                if (!fs.existsSync(sourceDir)) {
                    fs.mkdirSync(sourceDir, { recursive: true });
                }

                const baseName = path.basename(resolvedVideoPath, path.extname(resolvedVideoPath)).replace(/[\/\\:*?"<>|]/g, '_');
                let targetAudioFilename = `${baseName}_audio.mp3`;
                let outputPath = path.join(sourceDir, targetAudioFilename);
                let counter = 1;
                while (fs.existsSync(outputPath)) {
                    targetAudioFilename = `${baseName}_audio_${counter}.mp3`;
                    outputPath = path.join(sourceDir, targetAudioFilename);
                    counter++;
                }

                const ffmpegBin = getFFmpegBinary();
                // MP3 고음질 추출 (192kbps)
                const args = ['-y', '-i', resolvedVideoPath, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outputPath];
                console.log(`[LookVideoEditor] 오디오 분리 추출 시작: ${ffmpegBin} ${args.join(' ')}`);

                const child = spawn(ffmpegBin, args);
                let stderr = '';
                child.stderr.on('data', d => { stderr += d.toString('utf8'); });

                child.on('close', code => {
                    if (code === 0 && fs.existsSync(outputPath)) {
                        console.log(`[LookVideoEditor] 오디오 분리 추출 성공: ${outputPath}`);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            filename: targetAudioFilename,
                            audioPath: outputPath,
                            url: `/source/${encodeURIComponent(targetAudioFilename)}`
                        }));
                    } else {
                        console.warn(`[LookVideoEditor] 오디오 추출 실패(코드 ${code}):`, stderr.slice(-300));
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `오디오 추출 실패(코드 ${code}): ${stderr.slice(-200)}` }));
                    }
                });

                child.on('error', err => {
                    console.error('[LookVideoEditor] FFmpeg 실행 에러:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: err.message }));
                });
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
            }
        });
        return;
    }

    // --- 정적 파일 서빙 (HTTP 206 Partial Content 비디오 스트리밍 지원) ---
    let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\') {
        safePath = 'index.html';
    }

    const filePath = path.join(ROOT_DIR, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const range = req.headers.range;

        if (range && (ext === '.mp4' || ext === '.webm' || ext === '.mp3')) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stats.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
            });
            file.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stats.size,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes'
            });
            const stream = fs.createReadStream(filePath);
            stream.pipe(res);
        }
    });
});

server.listen(PORT, () => {
    // 이전 실행이 비정상 종료되며 남긴 WebP 임시 폴더 정리
    const swept = cleanupOrphanTemps(WEBP_TEMP_ROOT);
    if (swept > 0) {
        console.log(` 🧹 이전 작업의 WebP 임시 폴더 ${swept}개를 정리했습니다.`);
    }

    console.log('=====================================================');
    console.log(` 🎬 LookVideoEditor Local Server Started!`);
    console.log(` 🔗 URL: http://localhost:${PORT}`);
    console.log(` ⚙️  FFmpeg: ${getFFmpegBinary()}`);
    console.log('=====================================================');
});

// 종료 시 진행 중인 FFmpeg 와 보류 중인 WebP 임시 파일 정리
function shutdown() {
    killAllProcesses();
    cleanupAllPending();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
