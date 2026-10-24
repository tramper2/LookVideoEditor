/**
 * LookVideoEditor - FFmpeg Command & Batch Script Generator
 * 
 * 이 모듈은 웹 타임라인의 편집 데이터를 분석하여,
 * 로컬 Windows 환경에서 작동하는 FFmpeg 명령어와 실행용 배치(.bat) 파일을 생성합니다.
 */

function getAudioTempoFilter(speed) {
    let filters = [];
    let remaining = speed;
    while (remaining > 2.0) {
        filters.push("atempo=2.0");
        remaining /= 2.0;
    }
    while (remaining < 0.5) {
        filters.push("atempo=0.5");
        remaining /= 0.5;
    }
    if (Math.abs(remaining - 1.0) > 0.01) {
        filters.push(`atempo=${remaining.toFixed(4)}`);
    }
    return filters.join(",");
}

/**
 * Video Track 1 에서 시간상 인접한 두 클립의 겹침을 "암시적 크로스디졸브" 구간으로 해석한다.
 *
 * 별도 플래그를 두지 않고 매번 타임라인 상태에서 새로 계산하므로,
 * 클립을 옮기거나 지워도 stale 트랜지션이 남지 않는다.
 * 프리뷰(app.js)와 렌더가 이 함수를 공유해야 결과가 일치한다.
 *
 * @param {Array} clips  프로젝트 클립 배열
 * @param {number} outFPS 출력 fps
 * @returns {{[clipId: string]: {fadeIn: number, fadeOut: number, fadeOutStart: number}}}
 *          단위: 초 (절대 타임라인 시각)
 */
function computeVideo1Transitions(clips, outFPS) {
    // 반 프레임 미만 겹침은 전환으로 보지 않는다.
    // ffmpeg 의 fade/afade 는 d=0 을 만나면 에러 대신 프레임 수 모드로 조용히 폴백해서
    // 약 1초짜리 엉뚱한 페이드를 만들어버리므로, 여기서 반드시 잘라내야 한다.
    const EPS = 0.5 / (outFPS || 30);

    const sorted = (clips || [])
        .filter(c => c && c.track === 'video1')
        .sort((a, b) => (Number(a.timelineStart) || 0) - (Number(b.timelineStart) || 0));

    const map = {};
    sorted.forEach(c => { map[c.id] = { fadeIn: 0, fadeOut: 0, fadeOutStart: 0 }; });

    for (let i = 0; i < sorted.length - 1; i++) {
        const prev = sorted[i];
        const next = sorted[i + 1];

        const prevStart = Number(prev.timelineStart) || 0;
        const prevDur = Number(prev.duration) || 0;
        const nextDur = Number(next.duration) || 0;
        const overlap = (prevStart + prevDur) - (Number(next.timelineStart) || 0);
        if (overlap < EPS) continue;                 // 겹침 없음

        // 다음 클립이 앞 클립에 완전히 포함되면 overlap > nextDur 이 된다.
        // 페이드 길이가 자기 재생 길이를 넘으면 알파가 끝까지 1 에 도달하지 못하므로 잘라준다.
        const d = Math.min(overlap, nextDur);
        if (d < EPS) continue;

        map[next.id].fadeIn = d;

        // 완전 포함(삽입) 케이스에서는 prevEnd - d 가 겹침 구간이 아니라
        // 앞 클립의 꼬리를 가리키게 된다. 뒤에 아무것도 없는데 소리만 죽으므로 건드리지 않는다.
        const contained = overlap > nextDur + 1e-6;
        if (!contained) {
            map[prev.id].fadeOut = d;
            map[prev.id].fadeOutStart = (prevStart + prevDur) - d;   // == next.timelineStart
        }
    }

    return map;
}

// 여러 줄 자막의 줄 간격(글자 크기 대비 배수).
// app.js 의 프리뷰 자막 그리기와 반드시 같은 값이어야 미리보기와 결과가 일치한다.
const TEXT_LINE_SPACING = 1.3;

function generateFFmpegCommand(projectState) {
    const { clips, assets } = projectState;
    
    // 사용자가 지정한 출력 해상도 및 FPS 설정 추출 (기본값: 1920x1080 30fps)
    const outW = projectState.outputWidth || 1920;
    const outH = projectState.outputHeight || 1080;
    const outFPS = projectState.outputFps || 30;
    const encoder = projectState.encoder || 'h264_nvenc';
    
    // 트랙별 클립 분류
    const video1Clips = clips.filter(c => c.track === 'video1').sort((a, b) => a.timelineStart - b.timelineStart);
    const video2Clips = clips.filter(c => c.track === 'video2').sort((a, b) => a.timelineStart - b.timelineStart);
    const audioClips = clips.filter(c => c.track === 'audio').sort((a, b) => a.timelineStart - b.timelineStart);
    const overlayClips = clips.filter(c => c.track === 'overlay').sort((a, b) => a.timelineStart - b.timelineStart);

    // video1 인접 클립의 겹침 = 암시적 크로스디졸브 구간 (프리뷰와 공유하는 계산)
    const v1Transitions = computeVideo1Transitions(clips, outFPS);

    // 메인 비디오 트랙 1이 비어있으면 명령어를 생성하지 않음
    if (video1Clips.length === 0) {
        return {
            error: "메인 비디오 트랙(Video Track 1)에 최소 하나 이상의 비디오 클립이 존재해야 합니다.",
            command: "",
            batContent: "",
            outputFile: ""
        };
    }

    // 프로젝트 전체 실제 재생 길이 계산
    // 시각적 트랙(Video 1, Video 2, Overlay 자막/이미지/비디오)의 최대 끝점 기준
    // 영상이 끝난 후 자막만 나오는 구간(엔딩 카드 등)도 온전히 렌더링되도록 보장하고,
    // BGM(Audio)이 실수로 시각 요소보다 길어져 뒤쪽에 불필요한 검은 화면이 수 분간 렌더링되는 현상을 방지
    const visualClips = [video1Clips, video2Clips, overlayClips].flat();
    let maxVisualEnd = 0;
    visualClips.forEach(c => {
        const end = (Number(c.timelineStart) || 0) + (Number(c.duration) || 0);
        if (end > maxVisualEnd) maxVisualEnd = end;
    });

    let projectDuration = maxVisualEnd > 0 ? maxVisualEnd : 0;
    if (projectDuration <= 0) {
        clips.forEach(c => {
            const end = (Number(c.timelineStart) || 0) + (Number(c.duration) || 0);
            if (end > projectDuration) projectDuration = end;
        });
    }
    projectDuration = Math.max(0.1, parseFloat(projectDuration.toFixed(2)));

    let inputs = [];
    let rawInputs = [];
    let filterComplex = [];
    let currentInputIndex = 0;
    
    // 각 클립을 고유한 입력 번호로 매핑 (인풋 시킹 적용)
    // 1. Video Track 1 클립 입력 정의
    const video1Mappings = video1Clips.map((clip, index) => {
        const inputIdx = currentInputIndex++;
        // 정지 이미지 입력에는 -ss/-t 를 걸 수 없다 (프레임이 하나뿐이라 구간 자르기가 무의미).
        // 길이는 필터측 loop 로 만들어낸다. rawInputs.loop 은 -stream_loop 을 뜻하므로 넣지 않는다.
        if (clip.mediaType === 'image') {
            inputs.push(`-i "${clip.localPath}"`);
            rawInputs.push({ path: clip.localPath });
            return { clip, inputIdx };
        }
        const srcDur = clip.sourceEnd - clip.sourceStart;
        inputs.push(`-ss ${formatTime(clip.sourceStart)} -t ${formatTime(srcDur)} -i "${clip.localPath}"`);
        rawInputs.push({
            ss: formatTime(clip.sourceStart),
            t: formatTime(srcDur),
            path: clip.localPath
        });
        return { clip, inputIdx };
    });

    // 2. Video Track 2 (PIP) 클립 입력 정의
    const video2Mappings = video2Clips.map((clip, index) => {
        const inputIdx = currentInputIndex++;
        const srcDur = clip.sourceEnd - clip.sourceStart;
        inputs.push(`-ss ${formatTime(clip.sourceStart)} -t ${formatTime(srcDur)} -i "${clip.localPath}"`);
        rawInputs.push({
            ss: formatTime(clip.sourceStart),
            t: formatTime(srcDur),
            path: clip.localPath
        });
        return { clip, inputIdx };
    });

    // 3. Audio (BGM) 클립 입력 정의
    const audioMappings = audioClips.map((clip, index) => {
        const inputIdx = currentInputIndex++;

        // 반복 재생(loop) 처리
        //  -stream_loop 은 매 회차를 "파일 0초"에서 시작한다. 그래서 -ss 와 함께 쓰면
        //  회차마다 재생 구간이 어긋나므로(실측), 루프 클립은 파일 처음부터 읽는다.
        const useLoop = clip.loop === true;
        const loopSrcDur = useLoop ? Math.max(0.05, clip.sourceEnd || clip.duration) : 0;
        // -stream_loop N 은 "N회 추가 재생"(총 N+1회)이므로 필요한 만큼만 계산한다.
        // 최종 출력의 -t(projectDuration)가 정확히 잘라내므로 과다 반복은 문제되지 않는다.
        const loopCount = useLoop
            ? Math.max(0, Math.min(1000, Math.ceil(clip.duration / loopSrcDur) - 1))
            : 0;

        const readStart = useLoop ? 0 : clip.sourceStart;
        const readDur = (useLoop && loopCount > 0) ? clip.duration : (clip.sourceEnd - clip.sourceStart);
        const loopOption = loopCount > 0 ? `-stream_loop ${loopCount} ` : '';

        inputs.push(`${loopOption}-ss ${formatTime(readStart)} -t ${formatTime(readDur)} -i "${clip.localPath}"`);
        rawInputs.push({
            ss: formatTime(readStart),
            t: formatTime(readDur),
            path: clip.localPath,
            loop: loopCount        // 0 이면 루프 없음 (server.js 가 -stream_loop 을 넣지 않는다)
        });
        return { clip, inputIdx };
    });

    // 4. Overlay 이미지 및 비디오 입력 정의
    const imageClips = overlayClips.filter(c => c.overlayType === 'image');
    const imageMappings = imageClips.map((clip, index) => {
        const inputIdx = currentInputIndex++;
        inputs.push(`-i "${clip.localPath}"`);
        rawInputs.push({
            path: clip.localPath
        });
        return { clip, inputIdx };
    });

    // 4-1. Overlay 비디오 입력 정의 (오버레이 트랙의 비디오 클립)
    const overlayVideoClips = overlayClips.filter(c => c.overlayType === 'video');
    const overlayVideoMappings = overlayVideoClips.map((clip, index) => {
        const inputIdx = currentInputIndex++;
        const srcDur = clip.sourceEnd - clip.sourceStart;
        inputs.push(`-ss ${formatTime(clip.sourceStart)} -t ${formatTime(srcDur)} -i "${clip.localPath}"`);
        rawInputs.push({
            ss: formatTime(clip.sourceStart),
            t: formatTime(srcDur),
            path: clip.localPath
        });
        return { clip, inputIdx };
    });

    // --- Filter Complex 생성 ---
    // 베이스 블랙 캔버스 생성 (정확한 프로젝트 재생 길이 및 지정 해상도/FPS)
    filterComplex.push(`color=c=black:s=${outW}x${outH}:r=${outFPS}:d=${projectDuration.toFixed(2)}[base_canvas]`);
    let currentVideoNode = "base_canvas";
    let audioMixInputs = [];

    // 1. Video Track 1 클립 전처리 및 베이스 캔버스 상 오버레이 합성
    video1Mappings.forEach((mapping, i) => {
        const { clip, inputIdx } = mapping;
        const trans = v1Transitions[clip.id] || { fadeIn: 0, fadeOut: 0, fadeOutStart: 0 };
        const isStill = clip.mediaType === 'image';
        let vFilters = [];
        let aFilters = [];

        // 1.1 회전 (Transpose)
        if (clip.rotation === 90) vFilters.push("transpose=1");
        else if (clip.rotation === 180) vFilters.push("transpose=2,transpose=2");
        else if (clip.rotation === 270) vFilters.push("transpose=2");
        
        // 1.2 해상도 스케일링 및 패딩 (선택된 해상도에 맞춤, 레터박스/필러박스)
        vFilters.push(`scale=w='if(gte(iw/ih,${outW}/${outH}),${outW},-1)':h='if(gte(iw/ih,${outW}/${outH}),-1,${outH})'`);
        vFilters.push(`pad=${outW}:${outH}:(${outW}-iw)/2:(${outH}-ih)/2:black`);
        vFilters.push("setsar=1");

        // 1.2.1 정지 이미지 → duration 길이의 영상 스트림으로 부풀린다.
        //       이미지 입력의 기본 framerate 는 25fps(실측)이고 loop 은 N+1 프레임을 만든다.
        //       스케일/패딩 뒤에 두어 1프레임만 변환하고 복제한다(큰 사진에서 훨씬 싸다).
        //       초과분은 overlay 의 enable 창과 출력 -t 가 잘라내므로 조금 넘겨도 무해하다.
        if (isStill) {
            const stillFrames = Math.ceil(clip.duration * (clip.speed || 1.0) * 25) + 2;
            vFilters.push(`loop=loop=${stillFrames}:size=1:start=0`);
        }

        // 1.3 배속 조절 (Speed)
        const speed = clip.speed || 1.0;
        if (Math.abs(speed - 1.0) > 0.01) {
            vFilters.push(`setpts=PTS/${speed}`);
            const tempoFilter = getAudioTempoFilter(speed);
            if (tempoFilter) {
                aFilters.push(tempoFilter);
            }
        }

        // 1.4 효과 필터
        if (clip.effects && clip.effects.length > 0) {
            clip.effects.forEach(eff => {
                if (eff === 'grayscale') vFilters.push("hue=s=0");
                else if (eff === 'sepia') vFilters.push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131");
                else if (eff === 'reverse') vFilters.push("reverse");
                else if (eff === 'zoom_in') vFilters.push("scale=2*iw:-1,crop=iw/2:ih/2");
                else if (eff === 'zoom_out') vFilters.push("scale=0.5*iw:-1,pad=2*iw:2*ih:ow/4:oh/4:black");
                else if (eff === 'fade_out') {
                    const fadeDuration = (clip.fadeOutDuration !== undefined && clip.fadeOutDuration > 0) ? clip.fadeOutDuration : 0.5;
                    const fadeStartTime = Math.max(0, clip.duration - fadeDuration);
                    vFilters.push(`fade=t=out:st=${fadeStartTime.toFixed(2)}:d=${fadeDuration.toFixed(2)}`);
                }
            });
        }
        
        // 1.5 타임라인 위치로 PTS 이동 (overlay 프레임싱크 정합)
        //     overlay 는 enable 로 화면을 가려도 두 번째 입력의 프레임을 자기 PTS 순서대로 계속 소비한다.
        //     PTS 를 옮기지 않으면 timelineStart 이전 구간에서 클립 프레임이 전부 소진되고,
        //     기본 eof_action=repeat 때문에 마지막 프레임만 정지화면으로 남는다.
        //     (오디오는 adelay 로 이미 시프트되므로 영상만 맞춰주면 된다)
        const timelineOffset = clip.timelineStart || 0;
        if (timelineOffset > 0.001) {
            vFilters.push(`setpts=PTS+${timelineOffset.toFixed(2)}/TB`);
        }

        // 1.6 앞 클립과 겹치면 그 구간만큼 알파 페이드 인 = 크로스디졸브.
        //     setpts 로 절대 시각으로 옮긴 뒤이므로 st 는 절대 타임라인 초 단위다.
        //     앞 클립 overlay 가 이 구간에도 enable 상태로 아래에 깔려 있으므로 디졸브가 된다.
        //     alpha=1 이 없으면 색만 검게 죽어(알파 255 유지) 페이드투블랙이 되므로 반드시 필요하다.
        //     fade 의 alpha 는 알파 플레인을 요구하므로 yuva420p 로 변환해 넘긴다.
        if (trans.fadeIn > 0) {
            vFilters.push("format=yuva420p");
            vFilters.push(`fade=t=in:st=${clip.timelineStart.toFixed(2)}:d=${trans.fadeIn.toFixed(3)}:alpha=1`);
        }

        // FPS 통일
        vFilters.push(`fps=${outFPS}`);
        
        // 오디오 볼륨 및 샘플레이트 통일
        const vol = clip.volume !== undefined ? clip.volume : 1.0;
        aFilters.push(`volume=${vol}`);
        aFilters.push("aresample=44100");
        
        // 타임라인 위치에 맞추어 오디오 딜레이(adelay) 부여
        const delayMs = Math.round(clip.timelineStart * 1000);
        if (delayMs > 0) {
            aFilters.push(`adelay=${delayMs}|${delayMs}`);
        }
        
        // 1.7 오디오 크로스페이드 (영상과 같은 겹침 구간).
        //     adelay 이후이므로 st 는 절대 타임라인 초 단위다.
        //     영상 디졸브와 곡선을 맞추기 위해 기본 equal-gain(tri) 을 그대로 쓴다.
        if (trans.fadeIn > 0) {
            aFilters.push(`afade=t=in:st=${clip.timelineStart.toFixed(2)}:d=${trans.fadeIn.toFixed(3)}`);
        }
        if (trans.fadeOut > 0) {
            aFilters.push(`afade=t=out:st=${trans.fadeOutStart.toFixed(2)}:d=${trans.fadeOut.toFixed(3)}`);
        }

        const vProcessed = `v1_proc_${inputIdx}`;
        const aProcessed = `a1_delayed_${inputIdx}`;
        
        filterComplex.push(`[${inputIdx}:v]${vFilters.join(",")}[${vProcessed}]`);
        // 정지 이미지 입력, 오디오 스트림이 없는 비디오 또는 음소거(영상 전용) 클립은 오디오 스트림을 믹싱하지 않는다
        const hasNoAudio = isStill || clip.hasAudio === false || clip.muteAudio === true || (clip.volume !== undefined && clip.volume <= 0.001);
        if (!hasNoAudio) {
            filterComplex.push(`[${inputIdx}:a]${aFilters.join(",")}[${aProcessed}]`);
        }

        // 베이스 캔버스 위에 타임라인 위치(timelineStart)에 맞게 오버레이
        const nextVideoNode = `v1_layer_${inputIdx}`;
        const endTimeline = clip.timelineStart + clip.duration;
        filterComplex.push(`[${currentVideoNode}][${vProcessed}]overlay=x=0:y=0:enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;

        // 정지 이미지 및 음소거된 비디오는 소리가 없으므로 amix 입력에 넣지 않는다
        if (!hasNoAudio) {
            audioMixInputs.push(`[${aProcessed}]`);
        }
    });
    
    // 2. Video Track 2 (PIP) 전처리 및 오버레이 합성
    video2Mappings.forEach((mapping, i) => {
        const { clip, inputIdx } = mapping;
        let vFilters = [];
        let aFilters = [];
        
        // 2.1 회전
        if (clip.rotation === 90) vFilters.push("transpose=1");
        else if (clip.rotation === 180) vFilters.push("transpose=2,transpose=2");
        else if (clip.rotation === 270) vFilters.push("transpose=2");
        
        // 2.2 PIP 크기 스케일 (기본 320x180)
        const pip = clip.pip || { width: 320, height: 180, x: 20, y: 20 };
        const scaleX = outW / 1280;
        const scaleY = outH / 720;
        const pipW = Math.round(pip.width * scaleX);
        const pipH = Math.round(pip.height * scaleY);
        const pipX = Math.round(pip.x * scaleX);
        const pipY = Math.round(pip.y * scaleY);

        vFilters.push(`scale=${pipW}:${pipH}`);
        vFilters.push("setsar=1");
        
        // 2.3 배속 조절
        const speed = clip.speed || 1.0;
        if (Math.abs(speed - 1.0) > 0.01) {
            vFilters.push(`setpts=PTS/${speed}`);
            const tempoFilter = getAudioTempoFilter(speed);
            if (tempoFilter) {
                aFilters.push(tempoFilter);
            }
        }

        // 2.4 효과
        if (clip.effects && clip.effects.length > 0) {
            clip.effects.forEach(eff => {
                if (eff === 'grayscale') vFilters.push("hue=s=0");
                else if (eff === 'sepia') vFilters.push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131");
                else if (eff === 'reverse') vFilters.push("reverse");
                else if (eff === 'fade_out') {
                    const fadeDuration = (clip.fadeOutDuration !== undefined && clip.fadeOutDuration > 0) ? clip.fadeOutDuration : 0.5;
                    const fadeStartTime = Math.max(0, clip.duration - fadeDuration);
                    vFilters.push(`fade=t=out:st=${fadeStartTime.toFixed(2)}:d=${fadeDuration.toFixed(2)}:alpha=1`);
                }
            });
        }
        
        // 2.4.1 크로마키 (단색 배경 투명화)
        if (clip.chromakey) {
            const hex = (clip.chromakeyColor || '#00ff00').replace('#', '0x');
            const simNum = clip.chromakeySimilarity !== undefined ? (clip.chromakeySimilarity > 1 ? clip.chromakeySimilarity / 100 : clip.chromakeySimilarity) : 0.25;
            const sim = Math.max(0.01, Math.min(1.0, simNum)).toFixed(2);
            const blendNum = clip.chromakeyBlend !== undefined ? (clip.chromakeyBlend > 1 ? clip.chromakeyBlend / 100 : clip.chromakeyBlend) : 0.1;
            const blend = Math.max(0.0, Math.min(0.5, blendNum)).toFixed(2);
            vFilters.push(`colorkey=${hex}:${sim}:${blend}`);
            vFilters.push("format=yuva420p");
        }

        vFilters.push(`fps=${outFPS}`);
        
        // 2.5 타임라인 위치로 PTS 이동 (overlay 프레임싱크 정합, Video Track 1 과 동일한 이유)
        const timelineOffset = clip.timelineStart || 0;
        if (timelineOffset > 0.001) {
            vFilters.push(`setpts=PTS+${timelineOffset.toFixed(2)}/TB`);
        }

        const vol = clip.volume !== undefined ? clip.volume : 1.0;
        aFilters.push(`volume=${vol}`);
        aFilters.push("aresample=44100");
        
        // 타임라인 위치에 맞추어 오디오 딜레이(adelay) 부여
        const delayMs = Math.round(clip.timelineStart * 1000);
        if (delayMs > 0) {
            aFilters.push(`adelay=${delayMs}|${delayMs}`);
        }
        
        const hasNoAudio = clip.hasAudio === false || clip.muteAudio === true || (clip.volume !== undefined && clip.volume <= 0.001);
        const vProcessed = `v2_processed_${inputIdx}`;
        const aDelayed = `a2_delayed_${inputIdx}`;
        
        filterComplex.push(`[${inputIdx}:v]${vFilters.join(",")}[${vProcessed}]`);
        if (!hasNoAudio) {
            filterComplex.push(`[${inputIdx}:a]${aFilters.join(",")}[${aDelayed}]`);
        }
        
        // 오버레이 합성 (출현 구간 설정)
        const nextVideoNode = `v_overlay_${inputIdx}`;
        const endTimeline = clip.timelineStart + clip.duration;
        filterComplex.push(`[${currentVideoNode}][${vProcessed}]overlay=x=${pipX}:y=${pipY}:enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;
        
        if (!hasNoAudio) {
            audioMixInputs.push(`[${aDelayed}]`);
        }
    });
    
    // 3. Audio Track (BGM 및 분리된 오디오) 오디오 딜레이 및 믹싱 대기
    audioMappings.forEach((mapping, i) => {
        const { clip, inputIdx } = mapping;
        const isMuted = clip.muteAudio === true || (clip.volume !== undefined && clip.volume <= 0.001);
        if (isMuted) return;

        let aFilters = [];
        const vol = clip.volume !== undefined ? clip.volume : 1.0;
        aFilters.push(`volume=${vol}`);
        aFilters.push("aresample=44100");
        
        const delayMs = Math.round(clip.timelineStart * 1000);
        if (delayMs > 0) {
            aFilters.push(`adelay=${delayMs}|${delayMs}`);
        }
        
        const aDelayed = `bgm_delayed_${inputIdx}`;
        filterComplex.push(`[${inputIdx}:a]${aFilters.join(",")}[${aDelayed}]`);
        audioMixInputs.push(`[${aDelayed}]`);
    });
    
    // 4. Overlay PNG 이미지 합성 (크로마키 지원)
    imageMappings.forEach((mapping, i) => {
        const { clip, inputIdx } = mapping;
        const scaleX = outW / 1280;
        const scaleY = outH / 720;
        const imgW = Math.round((clip.width || 100) * scaleX);
        const imgH = Math.round((clip.height || 100) * scaleY);
        const imgX = Math.round(clip.x * scaleX);
        const imgY = Math.round(clip.y * scaleY);
        
        let imgFilters = [`scale=${imgW}:${imgH}`, "setsar=1"];
        if (clip.chromakey) {
            const hex = (clip.chromakeyColor || '#00ff00').replace('#', '0x');
            const simNum = clip.chromakeySimilarity !== undefined ? (clip.chromakeySimilarity > 1 ? clip.chromakeySimilarity / 100 : clip.chromakeySimilarity) : 0.25;
            const sim = Math.max(0.01, Math.min(1.0, simNum)).toFixed(2);
            const blendNum = clip.chromakeyBlend !== undefined ? (clip.chromakeyBlend > 1 ? clip.chromakeyBlend / 100 : clip.chromakeyBlend) : 0.1;
            const blend = Math.max(0.0, Math.min(0.5, blendNum)).toFixed(2);
            imgFilters.push(`colorkey=${hex}:${sim}:${blend}`);
            imgFilters.push("format=yuva420p");
        }

        const imgProcessed = `img_${inputIdx}`;
        filterComplex.push(`[${inputIdx}:v]${imgFilters.join(",")}[${imgProcessed}]`);
        
        const nextVideoNode = `v_img_overlay_${inputIdx}`;
        const endTimeline = clip.timelineStart + clip.duration;
        filterComplex.push(`[${currentVideoNode}][${imgProcessed}]overlay=x=${imgX}:y=${imgY}:enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;
    });

    // 4-1. Overlay 비디오 합성 (크로마키 지원)
    overlayVideoMappings.forEach((mapping, i) => {
        const { clip, inputIdx } = mapping;
        const scaleX = outW / 1280;
        const scaleY = outH / 720;
        const vidW = Math.round((clip.width || 320) * scaleX);
        const vidH = Math.round((clip.height || 180) * scaleY);
        const vidX = Math.round(clip.x * scaleX);
        const vidY = Math.round(clip.y * scaleY);

        let vFilters = [];
        if (clip.rotation === 90) vFilters.push("transpose=1");
        else if (clip.rotation === 180) vFilters.push("transpose=2,transpose=2");
        else if (clip.rotation === 270) vFilters.push("transpose=2");

        vFilters.push(`scale=${vidW}:${vidH}`);
        vFilters.push("setsar=1");

        const speed = clip.speed || 1.0;
        if (Math.abs(speed - 1.0) > 0.01) {
            vFilters.push(`setpts=PTS/${speed}`);
        }

        if (clip.chromakey) {
            const hex = (clip.chromakeyColor || '#00ff00').replace('#', '0x');
            const simNum = clip.chromakeySimilarity !== undefined ? (clip.chromakeySimilarity > 1 ? clip.chromakeySimilarity / 100 : clip.chromakeySimilarity) : 0.25;
            const sim = Math.max(0.01, Math.min(1.0, simNum)).toFixed(2);
            const blendNum = clip.chromakeyBlend !== undefined ? (clip.chromakeyBlend > 1 ? clip.chromakeyBlend / 100 : clip.chromakeyBlend) : 0.1;
            const blend = Math.max(0.0, Math.min(0.5, blendNum)).toFixed(2);
            vFilters.push(`colorkey=${hex}:${sim}:${blend}`);
            vFilters.push("format=yuva420p");
        }

        const timelineOffset = clip.timelineStart || 0;
        if (timelineOffset > 0.001) {
            vFilters.push(`setpts=PTS+${timelineOffset.toFixed(2)}/TB`);
        }
        vFilters.push(`fps=${outFPS}`);

        const vidProcessed = `vid_overlay_${inputIdx}`;
        filterComplex.push(`[${inputIdx}:v]${vFilters.join(",")}[${vidProcessed}]`);

        const nextVideoNode = `v_vid_overlay_node_${inputIdx}`;
        const endTimeline = clip.timelineStart + clip.duration;
        filterComplex.push(`[${currentVideoNode}][${vidProcessed}]overlay=x=${vidX}:y=${vidY}:enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;
    });
    
    // 5. Overlay 텍스트 (자막) drawtext 필터 적용
    const textClips = overlayClips.filter(c => c.overlayType === 'text');
    textClips.forEach((clip, i) => {
        const endTimeline = Math.min(projectDuration, clip.timelineStart + clip.duration);
        const scale = outW / 1280;
        const fontSize = Math.round((clip.textSize || 44) * scale);
        const fontColor = clip.textColor || "#ffffff";
        const opacityVal = (clip.textOpacity !== undefined ? clip.textOpacity : 100) / 100;
        const fontColorWithAlpha = `${fontColor}@${opacityVal.toFixed(2)}`;
        const fontPath = getFFmpegFontPath(clip.textFont || 'malgun', clip.textFontCustom, clip.textWeight === 'bold', clip.text);

        // 문자 효과 (외곽선 / 그림자)
        let textEffectOpts = '';
        const textEffect = clip.textEffect || 'none';
        if (textEffect === 'outline') {
            textEffectOpts = ':borderw=3:bordercolor=black';
        } else if (textEffect === 'shadow') {
            textEffectOpts = ':shadowx=2:shadowy=2:shadowcolor=black@0.8';
        } else if (textEffect === 'outline_shadow') {
            textEffectOpts = ':borderw=3:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=black@0.8';
        }

        // 배경 상자: 명시적으로 'on'일 때만 적용 (기본값은 off)
        const boxOpts = clip.textBgbox === 'on' ? ':box=1:boxcolor=black@0.4' : '';

        const clipX = (clip.x !== undefined && clip.x !== null) ? clip.x : 640;
        const clipY = (clip.y !== undefined && clip.y !== null) ? clip.y : 600;
        const textXExpr = clipX === 640 ? "(w-text_w)/2" : `${Math.round(clipX * (outW / 1280))}`;
        const baseY = Math.round(clipY * (outH / 720));

        // 여러 줄 처리: 줄마다 drawtext 를 따로 건다.
        //  text='...' 안에 진짜 개행문자를 넣으면 drawtext 가 줄바꿈은 하되
        //  그 개행문자를 글리프로도 그려서 두부(□) 사각형이 함께 나온다(실측 확인).
        //  백슬래시 이스케이프(\n)는 리터럴 문자로 렌더링되어 역시 쓸 수 없다.
        //  \r 은 남아 있으면 그 자체가 두부로 보이므로 먼저 제거한다.
        const lines = String(clip.text || '').replace(/\r/g, '').split('\n');
        const lineHeight = fontSize * TEXT_LINE_SPACING;
        const lineCount = lines.length;

        let textNode = currentVideoNode;
        lines.forEach((line, li) => {
            if (line.length === 0) return;   // 빈 줄은 자리만 차지한다 (필터를 만들지 않음)

            // 特수문자 escape (FFmpeg drawtext 규격)
            // 1) 백슬래시 이스케이프
            let textEscaped = line.replace(/\\/g, '\\\\');
            // 2) 작은따옴표: text='...' 내부에서 따옴표를 닫고 이스케이프된 따옴표를 넣고 다시 염
            textEscaped = textEscaped.replace(/'/g, "'\\''");
            // 3) 콜론(:) 이스케이프 (필터 옵션 구분자 충돌 방지)
            textEscaped = textEscaped.replace(/:/g, '\\:');
            // 4) 퍼센트(%) 이스케이프 (strftime 확장 방지)
            textEscaped = textEscaped.replace(/%/g, '\\%');

            // 캔버스 프리뷰(textBaseline='middle')와 FFmpeg(top) 기준선 일치를 위해 fontSize * 0.45 오프셋 보정
            const textYExpr = `${Math.round(baseY + (li - (lineCount - 1) / 2) * lineHeight - fontSize * 0.45)}`;

            const nextVideoNode = `v_text_overlay_${i}_${li}`;
            filterComplex.push(`[${textNode}]drawtext=text='${textEscaped}':x=${textXExpr}:y=${textYExpr}:fontsize=${fontSize}:fontcolor=${fontColorWithAlpha}${textEffectOpts}${boxOpts}:expansion=none:fontfile='${fontPath}':enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
            textNode = nextVideoNode;
        });
        currentVideoNode = textNode;
    });

    // 6. 오디오 최종 믹싱 (amix)
    let finalAudioNode = "a_final";
    if (audioMixInputs.length > 0) {
        if (audioMixInputs.length === 1) {
            finalAudioNode = audioMixInputs[0].slice(1, -1);
        } else {
            filterComplex.push(`${audioMixInputs.join("")}amix=inputs=${audioMixInputs.length}:duration=longest:dropout_transition=0[a_mixed]`);
            finalAudioNode = "a_mixed";
        }
    } else {
        filterComplex.push(`anullsrc=r=44100:cl=stereo:d=${projectDuration.toFixed(2)}[a_silent]`);
        finalAudioNode = "a_silent";
    }
    
    const filterString = filterComplex.join(";");
    // 출력 경로: 릴스 폴더 선택 시 samples/{폴더}/reels/에 저장, 아니면 기존 output/
    const reelsFolder = String(projectState.reelsFolder || '');
    const safeFolder = (reelsFolder !== '__ALL__' && /^[\w가-힣\-_]+$/.test(reelsFolder)) ? reelsFolder : '';
    const outputFilename = safeFolder
        ? `..\\samples\\${safeFolder}\\reels\\rendered_${formatDateForFilename(new Date())}.mp4`
        : `output\\rendered_${formatDateForFilename(new Date())}.mp4`;
    
    // 인코더 플래그 결정 (GPU NVENC vs CPU libx264)
    let videoCodecOption = "-c:v libx264 -preset medium -crf 20";
    if (encoder === 'h264_nvenc') {
        videoCodecOption = "-c:v h264_nvenc -preset p5 -cq 20";
    }
    
    const mappedVideo = `[${currentVideoNode}]`;
    const mappedAudio = `[${finalAudioNode}]`;
    
    // 순수 FFmpeg 단일 명령어 문자열
    const fullCommand = `ffmpeg -y ${inputs.join(" ")} -filter_complex "${filterString}" -map "${mappedVideo}" -map "${mappedAudio}" -t ${projectDuration.toFixed(2)} ${videoCodecOption} -pix_fmt yuv420p -r ${outFPS} -c:a aac -b:a 192k -ar 44100 "${outputFilename}"`;
    
    // Windows 실행용 배치파일 내용
    const batContent = `@echo off
chcp 65001 >nul
title LookVideoEditor - Local Renderer
echo =====================================================================
echo  Starting LookVideoEditor Video Rendering Task...
echo =====================================================================
echo.

REM 1. Check FFMPEG path
set FFMPEG_BIN=ffmpeg.exe
if exist "ffmpeg\\ffmpeg.exe" goto USE_LOCAL_FFMPEG

where ffmpeg >nul 2>nul
if %errorlevel% equ 0 goto USE_SYSTEM_FFMPEG

echo [ERROR] ffmpeg.exe was not found!
echo Please place ffmpeg.exe in the 'ffmpeg' folder or add it to system PATH.
echo See 'ffmpeg\\README.txt' for installation instructions.
echo.
pause
exit /b 1

:USE_LOCAL_FFMPEG
set FFMPEG_BIN="ffmpeg\\ffmpeg.exe"
echo [INFO] Using local FFMPEG binary from 'ffmpeg' directory.
goto PATH_CHECK_DONE

:USE_SYSTEM_FFMPEG
set FFMPEG_BIN=ffmpeg
echo [INFO] Using system FFMPEG binary from environment PATH.
goto PATH_CHECK_DONE

:PATH_CHECK_DONE
REM 2. Verify Output Directory
if not exist "output" mkdir "output"
if exist "output" echo [INFO] Output directory 'output' verified.

echo.
echo [INFO] Executing FFMPEG filters and encoding...
echo.

REM 3. Run FFMPEG
%FFMPEG_BIN% -y ${inputs.join(" ")} -filter_complex "${filterString.replace(/"/g, '\"')}" -map "${mappedVideo}" -map "${mappedAudio}" -t ${projectDuration.toFixed(2)} ${videoCodecOption} -pix_fmt yuv420p -r ${outFPS} -c:a aac -b:a 192k -ar 44100 "${outputFilename}"

if %errorlevel% neq 0 goto RENDER_ERROR

echo.
echo =====================================================================
echo  [SUCCESS] Rendering completed successfully!
echo  Output File: ${outputFilename}
echo =====================================================================
goto END

:RENDER_ERROR
echo.
echo =====================================================================
echo  [ERROR] Rendering failed! (Exit Code: %errorlevel%)
echo  Please verify local file paths or check the console logs above.
echo =====================================================================
goto END

:END
pause
`;

    return {
        command: fullCommand,
        batContent: batContent,
        outputFile: outputFilename,
        projectDuration: projectDuration,
        filterString: filterString,
        filterComplex: filterComplex,
        inputs: inputs,
        rawInputs: rawInputs,
        mappedVideo: mappedVideo,
        mappedAudio: mappedAudio,
        videoCodecOption: videoCodecOption,
        outFPS: outFPS
    };
}

/**
 * 초 단위를 HH:MM:SS.mmm 포맷 문자열로 변환
 */
function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00:00.000";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function pad(num, size) {
    let s = num + "";
    while (s.length < size) s = "0" + s;
    return s;
}

function formatDateForFilename(date) {
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1, 2);
    const d = pad(date.getDate(), 2);
    const hh = pad(date.getHours(), 2);
    const mm = pad(date.getMinutes(), 2);
    const ss = pad(date.getSeconds(), 2);
    return `${y}${m}${d}_${hh}${mm}${ss}`;
}

/**
 * 선택된 글꼴 키에 부합하는 Windows 로컬 FFMPEG 용 폰트 절대경로 반환
 */
function getFFmpegFontPath(textFont, textFontCustom, isBold, textContent) {
    // 한글 포함 여부 체크 (한글이 포함되어 있는데 영문 전용 폰트인 경우 맑은 고딕으로 안전 폴백)
    const hasKorean = textContent && /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(textContent);

    // custom 또는 직접 입력 경로 처리
    if ((textFont === 'custom' || String(textFont).startsWith('custom_')) && textFontCustom) {
        let path = textFontCustom.replace(/\\/g, '/');
        if (path.substring(1, 3) === ':/') {
            path = path.charAt(0) + '\\:' + path.substring(2);
        }
        return path;
    }

    // 굵게 옵션 적용 시
    if (isBold) {
        switch (textFont) {
            case 'arial':
                if (hasKorean) return 'C\\:/Windows/Fonts/malgunbd.ttf';
                return 'C\\:/Windows/Fonts/arialbd.ttf';
            case 'hyhead':
                return 'C\\:/Windows/Fonts/H2HDRM.TTF';
            case 'hygothic':
                return 'C\\:/Windows/Fonts/H2GTRM.TTF';
            case 'notosans':
                return 'C\\:/Windows/Fonts/NotoSansKR-VF.ttf';
            case 'notoserif':
                return 'C\\:/Windows/Fonts/NotoSerifKR-VF.ttf';
            case 'hypost':
                return 'C\\:/Windows/Fonts/H2PORM.TTF';
            case 'hygungsuh':
                return 'C\\:/Windows/Fonts/H2GSRB.TTF';
            case 'hymyungjo':
                return 'C\\:/Windows/Fonts/H2MJRE.TTF';
            case 'ngulim':
                return 'C\\:/Windows/Fonts/NGULIM.TTF';
            case 'gulim':
            case 'batang':
            case 'malgun':
            case 'malgunbd':
            default:
                return 'C\\:/Windows/Fonts/malgunbd.ttf';
        }
    }

    // 일반(Normal) 폰트 매핑
    switch (textFont) {
        case 'hyhead':
            return 'C\\:/Windows/Fonts/H2HDRM.TTF';
        case 'hygothic':
            return 'C\\:/Windows/Fonts/H2GTRM.TTF';
        case 'notosans':
            return 'C\\:/Windows/Fonts/NotoSansKR-VF.ttf';
        case 'notoserif':
            return 'C\\:/Windows/Fonts/NotoSerifKR-VF.ttf';
        case 'hypost':
            return 'C\\:/Windows/Fonts/H2PORM.TTF';
        case 'hygungsuh':
            return 'C\\:/Windows/Fonts/H2GSRB.TTF';
        case 'hymyungjo':
            return 'C\\:/Windows/Fonts/H2MJRE.TTF';
        case 'gulim':
            return 'C\\:/Windows/Fonts/gulim.ttc';
        case 'batang':
            return 'C\\:/Windows/Fonts/batang.ttc';
        case 'ngulim':
            return 'C\\:/Windows/Fonts/NGULIM.TTF';
        case 'malgunbd':
            return 'C\\:/Windows/Fonts/malgunbd.ttf';
        case 'arial':
            // 한글이 있으면 Arial에서 글자가 공백으로 증발하므로 맑은 고딕으로 폴백
            if (hasKorean) return 'C\\:/Windows/Fonts/malgun.ttf';
            return 'C\\:/Windows/Fonts/arial.ttf';
        case 'malgun':
        default:
            return 'C\\:/Windows/Fonts/malgun.ttf';
    }
}

// 브라우저에서는 전역 함수로, Node(검증 하네스 등)에서는 모듈로 쓸 수 있게 한다.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generateFFmpegCommand,
        computeVideo1Transitions,
        getAudioTempoFilter,
        getFFmpegFontPath,
        formatTime
    };
}
