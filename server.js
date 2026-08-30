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

const PORT = 3000;
const ROOT_DIR = __dirname;

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
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ico': 'image/x-icon'
};

// 렌더링 상태 관리
let renderState = {
    isRendering: false,
    progress: 0,
    currentTime: "00:00:00.00",
    totalDuration: 0,
    fps: "0",
    speed: "0x",
    status: "idle", // 'idle' | 'rendering' | 'completed' | 'error' | 'cancelled'
    error: null,
    outputFile: null,
    startTime: 0,
    elapsedTime: "00:00"
};

let currentFfmpegProcess = null;

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

const server = http.createServer((req, res) => {
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

    // 2. 렌더링 진행률 조회 (Polling / SSE 지원)
    if (pathname === '/api/render/progress' && req.method === 'GET') {
        if (renderState.isRendering && renderState.startTime > 0) {
            renderState.elapsedTime = formatElapsed(Date.now() - renderState.startTime);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(renderState));
        return;
    }

    // 3. 렌더링 시작
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
                const { command, outputFile, totalDuration } = data;

                if (!command) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'FFmpeg 명령어가 제공되지 않았습니다.' }));
                    return;
                }

                // output 디렉터리 확인 및 생성
                const outputDir = path.join(ROOT_DIR, 'output');
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }

                // 상태 초기화
                renderState = {
                    isRendering: true,
                    progress: 0,
                    currentTime: "00:00:00.00",
                    totalDuration: totalDuration || 10,
                    fps: "0",
                    speed: "0x",
                    status: "rendering",
                    error: null,
                    outputFile: outputFile || path.join('output', 'rendered_video.mp4'),
                    startTime: Date.now(),
                    elapsedTime: "00:00"
                };

                const ffmpegBin = getFFmpegBinary();
                console.log(`[LookVideoEditor] 렌더링 시작: ${ffmpegBin}`);
                console.log(`[LookVideoEditor] 출력 파일: ${renderState.outputFile}`);

                let actualCmd = command;
                if (actualCmd.startsWith('ffmpeg ')) {
                    actualCmd = `"${ffmpegBin}" ` + actualCmd.substring(7);
                }

                // Windows cmd 따옴표 파싱 에러 방지를 위해 임시 실행 배치파일을 통해 실행
                const tempBatPath = path.join(ROOT_DIR, '_render_task.bat');
                const batScript = `@echo off
chcp 65001 >nul
cd /d "${ROOT_DIR}"
${actualCmd}
`;
                fs.writeFileSync(tempBatPath, batScript, 'utf8');

                const child = spawn('cmd.exe', ['/c', tempBatPath], {
                    cwd: ROOT_DIR,
                    windowsHide: true
                });

                currentFfmpegProcess = child;

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
                    currentFfmpegProcess = null;
                    try {
                        if (fs.existsSync(tempBatPath)) fs.unlinkSync(tempBatPath);
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
                    currentFfmpegProcess = null;
                    try {
                        if (fs.existsSync(tempBatPath)) fs.unlinkSync(tempBatPath);
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

    // 4. 렌더링 취소
    if (pathname === '/api/render/cancel' && req.method === 'POST') {
        if (currentFfmpegProcess) {
            renderState.status = 'cancelled';
            renderState.isRendering = false;
            try {
                // Windows 프로세스 트리 강제 종료
                exec(`taskkill /pid ${currentFfmpegProcess.pid} /T /F`, () => {});
            } catch (e) {
                currentFfmpegProcess.kill('SIGKILL');
            }
            currentFfmpegProcess = null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'cancelled' }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'no_active_render' }));
        }
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

            const fullPath = targetFile ? path.resolve(ROOT_DIR, targetFile) : path.resolve(ROOT_DIR, 'output');
            if (fs.existsSync(fullPath)) {
                exec(`explorer.exe /select,"${fullPath}"`, (err) => {
                    if (err) exec(`explorer.exe "${path.resolve(ROOT_DIR, 'output')}"`);
                });
            } else {
                exec(`explorer.exe "${path.resolve(ROOT_DIR, 'output')}"`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'opened' }));
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

            const fullPath = targetFile ? path.resolve(ROOT_DIR, targetFile) : null;
            if (fullPath && fs.existsSync(fullPath)) {
                exec(`start "" "${fullPath}"`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'opened' }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '파일을 찾을 수 없습니다.' }));
            }
        });
        return;
    }

    // --- 정적 파일 서빙 ---
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

        res.writeHead(200, { 'Content-Type': contentType });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

server.listen(PORT, () => {
    console.log('=====================================================');
    console.log(` 🎬 LookVideoEditor Local Server Started!`);
    console.log(` 🔗 URL: http://localhost:${PORT}`);
    console.log(` ⚙️  FFmpeg: ${getFFmpegBinary()}`);
    console.log('=====================================================');
});
