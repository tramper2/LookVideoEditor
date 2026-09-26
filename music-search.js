/**
 * LookVideoEditor - 무료 음악 검색 모듈 (서버 전용)
 *
 * Openverse API(https://api.openverse.org)에서 저작권 제약이 없는 CC0·퍼블릭 도메인 음악만
 * 검색하고, 내려받아 로컬 source/ 폴더에 저장한다.
 *
 * - API 키가 필요 없다(익명 접근). 레이트 리밋은 분당 20회 / 일 200회이므로
 *   모든 업스트림 호출을 1초 간격으로 직렬화하고 일일 카운터를 따로 센다.
 * - 브라우저가 로드하지 않고 server.js 가 require 한다. (webp-exporter.js 와 같은 구조)
 * - npm 의존성 없이 Node 18+ 내장 fetch 만 사용한다.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OPENVERSE_BASE = 'https://api.openverse.org/v1/audio/';
const USER_AGENT = 'LookVideoEditor/2.2 (+http://localhost)';
const REQUEST_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;   // 30MB 상한
const DAILY_LIMIT = 200;                        // Openverse 익명 일일 한도

// ─────────────────────────────────────────────────────────────
// 한국어 검색어 → 영어 태그
// ─────────────────────────────────────────────────────────────
// Openverse 는 영어 태그 기반이라 한국어로는 결과가 사실상 없다.
// 값이 여러 개면 그대로 AND 검색이 되어 결과가 급감하므로(실측: "upbeat energetic" 5건)
// 번역 결과는 최대 2개로 제한한다.
const KO_EN = {
    // 분위기
    '잔잔한': ['calm'], '잔잔': ['calm'], '차분한': ['calm'], '조용한': ['quiet'],
    '평온한': ['peaceful'], '고요한': ['peaceful'], '편안한': ['relaxing'],
    '신나는': ['upbeat'], '경쾌한': ['upbeat'], '활기찬': ['upbeat'], '밝은': ['happy'],
    '슬픈': ['sad'], '애절한': ['sad'], '어두운': ['dark'], '따뜻한': ['warm'],
    '몽환적인': ['dreamy'], '웅장한': ['epic'], '긴장감': ['tense'], '로맨틱': ['romantic'],
    '감성적인': ['emotional'], '감성': ['emotional'], '귀여운': ['cute'], '시원한': ['chill'],
    // 장르 · 악기
    '피아노': ['piano'], '기타': ['guitar'], '어쿠스틱': ['acoustic'], '바이올린': ['violin'],
    '현악': ['strings'], '재즈': ['jazz'], '클래식': ['classical'], '오케스트라': ['orchestral'],
    '로파이': ['lofi'], '로파': ['lofi'], '일렉트로닉': ['electronic'], '일렉': ['electronic'],
    '앰비언트': ['ambient'], '신스': ['synth'], '힙합': ['hip hop'], '랩': ['hip hop'],
    '록': ['rock'], '팝': ['pop'], '드럼': ['drums'], '비트': ['beat'], '발라드': ['ballad'],
    '트로트': ['trot'], '재즈피아노': ['jazz piano'],
    // 용도 · 상황
    '카페': ['cafe'], '브이로그': ['vlog'], '여행': ['travel'], '광고': ['advertising'],
    '패션': ['fashion'], '룩북': ['fashion'], '쇼핑몰': ['shopping'], '인트로': ['intro'],
    '아웃트로': ['outro'], '배경음악': ['background'], '공부': ['study'], '집중': ['focus'],
    '명상': ['meditation'], '요가': ['yoga'], '수면': ['sleep'], '파티': ['party'],
    '운동': ['workout'], '게임': ['game'], '뉴스': ['news'], '다큐': ['documentary'],
};

// 토큰 끝에 붙는 조사/어미 (긴 것부터 검사해야 '으로'가 '로'보다 먼저 매칭된다)
const KO_SUFFIXES = ['으로', '에서', '에게', '부터', '까지', '처럼', '보다', '스러운', '적인', '하는',
    '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '로', '만', '한'];

function normalizeQuery(raw) {
    return String(raw || '').normalize('NFC').toLowerCase()
        .replace(/[^가-힣a-z0-9\s]/g, ' ')   // 한글·영문·숫자·공백만 남김
        .replace(/\s+/g, ' ')
        .trim();
}

function lookupToken(token) {
    if (KO_EN[token]) return KO_EN[token];
    for (const suffix of KO_SUFFIXES) {
        if (token.length > suffix.length + 1 && token.endsWith(suffix)) {
            const stem = token.slice(0, -suffix.length);
            if (KO_EN[stem]) return KO_EN[stem];
        }
    }
    return null;
}

/**
 * 한국어 검색어를 영어 태그로 변환한다.
 * 한글이 없으면 그대로 통과(사용자가 영어로 입력한 경우).
 * 변환에 실패해도 검색은 원문으로 수행하고 failed 플래그만 세운다.
 */
function translateQuery(raw) {
    const normalized = normalizeQuery(raw);
    if (!normalized) {
        return { original: String(raw || ''), translated: '', wasTranslated: false, failed: true };
    }
    // 한글이 없으면 영어 입력으로 보고 그대로 쓴다
    if (!/[가-힣]/.test(normalized)) {
        return { original: raw, translated: normalized, wasTranslated: false, failed: false };
    }

    const tokens = normalized.split(' ');
    const out = [];
    for (let i = 0; i < tokens.length;) {
        let matched = null;
        let used = 0;
        // 3어절 → 1어절 순 최장 일치
        for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
            const phrase = tokens.slice(i, i + n).join('');
            if (KO_EN[phrase]) { matched = KO_EN[phrase]; used = n; break; }
            if (n === 1) {
                const single = lookupToken(tokens[i]);
                if (single) { matched = single; used = 1; }
            }
        }
        if (matched) {
            matched.forEach(w => { if (!out.includes(w)) out.push(w); });
            i += used;
        } else {
            // 사전에 없는 토큰: 영문이면 살리고 한글이면 버린다
            if (!/[가-힣]/.test(tokens[i])) out.push(tokens[i]);
            i += 1;
        }
    }

    const translated = out.slice(0, 2).join(' ');   // AND 검색이므로 2개까지만
    return {
        original: raw,
        translated,
        wasTranslated: true,
        failed: translated.length === 0,
    };
}

/**
 * UI 의 빠른 선택 버튼에 쓸 대표 키워드.
 * 모두 단일 단어다 — 2단어는 AND 검색이 되어 결과가 급감한다(실측 "upbeat energetic" 5건).
 */
function getQuickKeywords() {
    return [
        { en: 'calm', ko: '잔잔한' },
        { en: 'lofi', ko: '로파이' },
        { en: 'upbeat', ko: '신나는' },
        { en: 'cinematic', ko: '영화같은' },
        { en: 'piano', ko: '피아노' },
        { en: 'acoustic', ko: '어쿠스틱' },
        { en: 'jazz', ko: '재즈' },
        { en: 'ambient', ko: '앰비언트' },
    ];
}

// ─────────────────────────────────────────────────────────────
// 업스트림 호출 직렬화 (분당 20회 / 일 200회)
// ─────────────────────────────────────────────────────────────
let callChain = Promise.resolve();
let lastCallAt = 0;
let dailyUsed = 0;
let dailyStamp = new Date().toDateString();
let lastRateLimit = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== dailyStamp) {
        dailyStamp = today;
        dailyUsed = 0;
    }
}

/** 모든 업스트림 호출을 1초 간격으로 직렬화한다 */
function enqueueCall(fn) {
    const run = callChain.then(async () => {
        const wait = Math.max(0, 1000 - (Date.now() - lastCallAt));
        if (wait > 0) await sleep(wait);
        lastCallAt = Date.now();
        return fn();
    });
    callChain = run.then(() => {}, () => {});   // 실패해도 체인이 끊기지 않게
    return run;
}

function getRateLimitInfo() {
    resetDailyIfNeeded();
    return {
        remaining: lastRateLimit ? lastRateLimit.remaining : null,
        limit: lastRateLimit ? lastRateLimit.limit : 20,
        dailyRemaining: Math.max(0, DAILY_LIMIT - dailyUsed),
        dailyLimit: DAILY_LIMIT,
    };
}

/** Openverse 호출 1건. 실패 시 { error, message, status } 를 담은 객체를 던진다 */
async function callOpenverse(url) {
    resetDailyIfNeeded();
    if (dailyUsed >= DAILY_LIMIT) {
        const err = new Error('오늘 사용할 수 있는 검색 횟수(200회)를 모두 사용했습니다. 내일 다시 시도해 주세요.');
        err.code = 'daily_limit_exceeded';
        err.status = 503;
        throw err;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
            });
            dailyUsed++;

            // 레이트 리밋 헤더 기록 (남은 횟수 표시용)
            const limitHeader = res.headers.get('x-ratelimit-limit-anon_burst');
            const remainHeader = res.headers.get('x-ratelimit-remaining-anon_burst');
            if (limitHeader || remainHeader) {
                lastRateLimit = {
                    limit: parseInt(limitHeader, 10) || 20,
                    remaining: parseInt(remainHeader, 10),
                };
            }

            if (res.status === 429) {
                if (attempt === 0) {
                    const retryAfter = Math.min(5, parseInt(res.headers.get('retry-after'), 10) || 2);
                    await sleep(retryAfter * 1000);
                    continue;
                }
                const err = new Error('검색 요청이 잠시 제한되었습니다. 몇 초 후 다시 시도해 주세요.');
                err.code = 'rate_limited';
                err.status = 429;
                throw err;
            }
            if (!res.ok) {
                const err = new Error(`음악 검색 서버 응답 오류 (${res.status})`);
                err.code = 'upstream_error';
                err.status = 502;
                err.upstreamStatus = res.status;
                throw err;
            }
            return await res.json();
        } catch (e) {
            if (e && e.code) throw e;    // 위에서 만든 에러는 그대로
            if (e && e.name === 'AbortError') {
                const err = new Error('음악 검색 서버 응답이 없습니다 (15초 초과).');
                err.code = 'timeout';
                err.status = 504;
                throw err;
            }
            const err = new Error('인터넷 연결을 확인해 주세요.');
            err.code = 'network_error';
            err.status = 502;
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
    // 도달하지 않음
    const err = new Error('음악 검색에 실패했습니다.');
    err.code = 'upstream_error';
    err.status = 502;
    throw err;
}

/** 검색 결과 1건을 클라이언트용으로 축약한다 */
function shapeItem(item) {
    const durationSec = Number(item.duration) > 0 ? Number(item.duration) / 1000 : 0;
    return {
        id: item.id,
        title: item.title || '(제목 없음)',
        creator: item.creator || '',
        license: item.license,
        licenseVersion: item.license_version || '',
        licenseUrl: item.license_url || '',
        provider: item.provider || item.source || '',
        durationSec: Math.round(durationSec * 10) / 10,
        filetype: item.filetype || 'mp3',
        filesize: item.filesize || 0,
        // 미리듣기 전용 — 서버는 이 URL 로 요청을 보내지 않는다
        previewUrl: item.url || '',
        // 출처 페이지 (foreign_landing_url)
        landingUrl: item.foreign_landing_url || '',
        attribution: item.attribution || '',
    };
}

/**
 * 음악을 검색한다.
 * @returns {{ query, resultCount, page, pageCount, results: Array }}
 */
async function searchMusic({ q, page = 1, pageSize = 20, minDurationSec, maxDurationSec }) {
    const query = translateQuery(q);
    const searchTerm = query.translated || query.original;
    if (!String(searchTerm || '').trim()) {
        const err = new Error('검색어를 입력해 주세요.');
        err.code = 'invalid_query';
        err.status = 400;
        throw err;
    }

    const params = new URLSearchParams({
        q: searchTerm,
        license: 'cc0,pdm',          // 저작권 제약이 없는 음악만
        page_size: String(Math.min(20, Math.max(1, pageSize))),
        page: String(Math.max(1, page)),
        filter_dead: 'true',         // 죽은 링크 제외
    });
    // Openverse 의 duration 필터는 밀리초 범위다
    if (minDurationSec > 0 || maxDurationSec > 0) {
        const minMs = minDurationSec > 0 ? Math.round(minDurationSec * 1000) : 0;
        const maxMs = maxDurationSec > 0 ? Math.round(maxDurationSec * 1000) : 36000000;
        params.set('duration', `${minMs}-${maxMs}`);
    }

    const data = await enqueueCall(() => callOpenverse(`${OPENVERSE_BASE}?${params.toString()}`));

    // 2차 안전장치: 라이선스와 재생 가능한 URL 을 서버가 다시 확인한다.
    // alt_files 는 Freesound API 토큰이 필요하므로 쓰지 않고 url 필드만 사용한다.
    const results = (data.results || [])
        .filter(item => (item.license === 'cc0' || item.license === 'pdm')
            && typeof item.url === 'string' && item.url.startsWith('https://'))
        .map(shapeItem);

    return {
        query,
        resultCount: data.result_count || 0,
        pageCount: data.page_count || 0,
        page: data.page || 1,
        rateLimit: getRateLimitInfo(),
        results,
    };
}

// ─────────────────────────────────────────────────────────────
// 다운로드
// ─────────────────────────────────────────────────────────────
/** 파일명에 쓸 수 없는 문자를 정리한다 (Windows 금지문자 + 경로 구분자 + 상위참조) */
function sanitizeForFilename(text) {
    const cleaned = String(text || '')
        .normalize('NFC')
        .replace(/\.(mp3|wav|ogg|m4a|flac|aac|mp4)$/i, '')   // 제목에 확장자가 섞여 있으면 제거 (중복 방지)
        .replace(/[/\\:*?"<>|\u0000-\u001F]/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^[.\s_]+|[.\s_]+$/g, '')                   // 앞뒤의 점·공백·언더스코어 제거
        .replace(/_+/g, '_')
        .slice(0, 40)
        .replace(/^[.\s_]+|[.\s_]+$/g, '');
    return cleaned || 'track';                               // 빈 제목 / 특수문자만 있는 제목
}

/** 같은 곡은 항상 같은 파일명이 되도록 결정적으로 만든다 (중복 다운로드 방지) */
function buildMusicFilename({ id, title, durationSec, filetype }) {
    // Openverse id 는 UUID 형식이므로 숫자만 뽑아도 충분히 구분된다
    const raw = String(id || '');
    const idPart = (raw.replace(/[^0-9]/g, '') || raw.replace(/[^0-9a-zA-Z]/g, '')).slice(0, 12) || 'x';
    const ext = /^(mp3|wav|ogg|m4a|flac|aac)$/.test(String(filetype || '').toLowerCase())
        ? String(filetype).toLowerCase() : 'mp3';
    const sec = Math.round(Number(durationSec) || 0);
    return `music_${idPart}_${sanitizeForFilename(title)}_${sec}s.${ext}`;
}

/** 오디오 파일인지 매직 바이트로 확인한다 */
function looksLikeAudio(buf) {
    if (buf.length < 12) return false;
    const ascii = (o, n) => buf.slice(o, o + n).toString('ascii');
    if (ascii(0, 3) === 'ID3') return true;                                  // mp3 (ID3 태그)
    if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true;            // mp3 프레임 싱크
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return true;       // wav
    if (ascii(0, 4) === 'OggS') return true;                                 // ogg
    if (ascii(4, 4) === 'ftyp') return true;                                 // m4a/mp4
    if (ascii(0, 4) === 'fLaC') return true;                                 // flac
    return false;
}

/** ffprobe 가 있으면 실제 길이를 확인한다 (ffmpeg/ 는 gitignore 대상이라 없을 수 있다) */
function probeDurationSec(filePath) {
    return new Promise(resolve => {
        const ffprobe = path.join(__dirname, 'ffmpeg',
            process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
        if (!fs.existsSync(ffprobe)) return resolve(null);

        const child = spawn(ffprobe, [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
        ], { windowsHide: true });

        let out = '';
        let done = false;
        const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { try { child.kill(); } catch (e) {} finish(null); }, 10000);

        child.stdout.on('data', c => { out += c.toString(); });
        child.on('close', code => {
            const sec = parseFloat(String(out).trim());
            finish(code === 0 && Number.isFinite(sec) && sec > 0 ? sec : null);
        });
        child.on('error', () => finish(null));
    });
}

let downloadInFlight = false;

/**
 * 곡을 내려받아 source/ 에 저장한다.
 * 클라이언트는 id 만 보내고, 서버가 Openverse 에서 URL 을 다시 조회하므로
 * 임의 호스트로 요청을 보낼 수 없다 (SSRF 차단 + 라이선스 재검증).
 */
async function downloadMusic({ id, sourceDir }) {
    if (!id || typeof id !== 'string' || !/^[0-9a-zA-Z:_-]{4,120}$/.test(id)) {
        const err = new Error('올바르지 않은 곡 식별자입니다.');
        err.code = 'invalid_id';
        err.status = 400;
        throw err;
    }
    if (downloadInFlight) {
        const err = new Error('다른 곡을 받는 중입니다. 잠시 후 다시 시도해 주세요.');
        err.code = 'busy';
        err.status = 409;
        throw err;
    }

    downloadInFlight = true;
    try {
        // 1) 서버가 직접 곡 정보를 재조회한다 (클라이언트가 준 URL 은 신뢰하지 않는다)
        const item = await enqueueCall(() => callOpenverse(OPENVERSE_BASE + encodeURIComponent(id) + '/'));

        if (item.license !== 'cc0' && item.license !== 'pdm') {
            const err = new Error('저작권 제약이 없는 음악(CC0·퍼블릭 도메인)만 추가할 수 있습니다.');
            err.code = 'license_not_allowed';
            err.status = 403;
            throw err;
        }
        if (typeof item.url !== 'string' || !item.url.startsWith('https://')) {
            const err = new Error('내려받을 수 있는 음원 주소가 없습니다.');
            err.code = 'no_download_url';
            err.status = 502;
            throw err;
        }
        // Openverse 가 안내하는 호스트만 허용 (실질 소스는 Freesound CDN)
        const host = new URL(item.url).hostname.toLowerCase();
        if (!/\.(freesound\.org|openverse\.org|wikimedia\.org)$/.test(host) && host !== 'freesound.org') {
            const err = new Error('허용되지 않은 음원 호스트입니다.');
            err.code = 'blocked_host';
            err.status = 403;
            throw err;
        }

        const durationSec = Number(item.duration) > 0 ? Number(item.duration) / 1000 : 0;
        const filename = buildMusicFilename({
            id: item.id, title: item.title, durationSec, filetype: item.filetype,
        });

        if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });
        const finalPath = path.join(sourceDir, path.basename(filename));

        // source/ 밖으로 나가지 않는지 재확인
        if (!finalPath.startsWith(sourceDir + path.sep)) {
            const err = new Error('저장 경로가 올바르지 않습니다.');
            err.code = 'bad_path';
            err.status = 400;
            throw err;
        }

        // 2) 이미 받아둔 곡이면 네트워크 호출 없이 재사용
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 1024) {
            return {
                success: true, reused: true, filename,
                localPath: finalPath,
                url: `/api/reels-file?path=${encodeURIComponent(finalPath)}`,
                bytes: fs.statSync(finalPath).size,
                durationSec, durationSource: 'api',
                title: item.title || filename, creator: item.creator || '',
                license: item.license, licenseUrl: item.license_url || '',
                landingUrl: item.foreign_landing_url || '',
                attribution: item.attribution || '',
            };
        }

        // 3) .part 로 받은 뒤 검증을 통과해야 확정한다 (중간에 죽어도 손상 파일이 남지 않음)
        const partPath = path.join(sourceDir, `.part_${path.basename(filename)}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        let bytes = 0;
        try {
            const res = await fetch(item.url, {
                signal: controller.signal,
                headers: { 'User-Agent': USER_AGENT },
            });
            if (!res.ok) {
                const err = new Error(`음원 다운로드 실패 (${res.status})`);
                err.code = 'download_failed';
                err.status = 502;
                throw err;
            }

            const { Readable } = require('stream');
            const { pipeline } = require('stream/promises');
            const body = Readable.fromWeb(res.body);
            body.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_DOWNLOAD_BYTES) {
                    body.destroy(new Error('too_large'));
                }
            });
            await pipeline(body, fs.createWriteStream(partPath));
        } catch (e) {
            try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (cleanupErr) {}
            if (e && e.code) throw e;
            if (e && (e.name === 'AbortError' || e.message === 'too_large')) {
                const err = new Error(e.message === 'too_large'
                    ? '음원 파일이 너무 큽니다 (30MB 초과).'
                    : '음원 다운로드가 지연되고 있습니다.');
                err.code = e.message === 'too_large' ? 'too_large' : 'timeout';
                err.status = e.message === 'too_large' ? 413 : 504;
                throw err;
            }
            const err = new Error('음원 다운로드에 실패했습니다.');
            err.code = 'download_failed';
            err.status = 502;
            throw err;
        } finally {
            clearTimeout(timer);
        }

        // 4) 검증: 크기 + 매직 바이트
        const stat = fs.existsSync(partPath) ? fs.statSync(partPath) : null;
        if (!stat || stat.size <= 1024) {
            try { fs.unlinkSync(partPath); } catch (e) {}
            const err = new Error('내려받은 파일이 손상되었습니다.');
            err.code = 'invalid_audio';
            err.status = 415;
            throw err;
        }
        const head = Buffer.alloc(16);
        const fd = fs.openSync(partPath, 'r');
        fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        if (!looksLikeAudio(head)) {
            try { fs.unlinkSync(partPath); } catch (e) {}
            const err = new Error('오디오 파일이 아닙니다.');
            err.code = 'invalid_audio';
            err.status = 415;
            throw err;
        }

        // 5) 원자적 확정
        fs.renameSync(partPath, finalPath);

        // 6) 실제 길이 확인 (ffprobe 가 있을 때만). 메타데이터보다 실제 파일을 신뢰한다.
        const probed = await probeDurationSec(finalPath);
        const finalDuration = probed || durationSec;

        writeCredit(sourceDir, {
            filename, title: item.title || filename, creator: item.creator || '',
            license: item.license, licenseUrl: item.license_url || '',
            landingUrl: item.foreign_landing_url || '', sourceId: item.id,
            downloadedAt: new Date().toISOString(),
        });

        return {
            success: true, reused: false, filename,
            localPath: finalPath,
            url: `/api/reels-file?path=${encodeURIComponent(finalPath)}`,
            bytes: stat.size,
            durationSec: finalDuration,
            durationSource: probed ? 'ffprobe' : 'api',
            title: item.title || filename, creator: item.creator || '',
            license: item.license, licenseUrl: item.license_url || '',
            landingUrl: item.foreign_landing_url || '',
            attribution: item.attribution || '',
        };
    } finally {
        downloadInFlight = false;
    }
}

/** 출처 기록을 사이드카 JSON 에 남긴다 (CC0 라 의무는 아니지만 추적용) */
function writeCredit(sourceDir, credit) {
    try {
        const creditPath = path.join(sourceDir, 'music_credits.json');
        let list = [];
        if (fs.existsSync(creditPath)) {
            try { list = JSON.parse(fs.readFileSync(creditPath, 'utf8')); } catch (e) { list = []; }
            if (!Array.isArray(list)) list = [];
        }
        list = list.filter(c => c && c.filename !== credit.filename);
        list.push(credit);
        fs.writeFileSync(creditPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        // 기록 실패가 다운로드 자체를 막지는 않는다
        console.warn('[LookVideoEditor] 음악 출처 기록 실패:', e.message);
    }
}

module.exports = {
    translateQuery,
    searchMusic,
    downloadMusic,
    buildMusicFilename,
    sanitizeForFilename,
    looksLikeAudio,
    getRateLimitInfo,
    getQuickKeywords,
};
