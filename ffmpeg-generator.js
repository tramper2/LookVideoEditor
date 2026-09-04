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
    
    // 메인 비디오 트랙 1이 비어있으면 명령어를 생성하지 않음
    if (video1Clips.length === 0) {
        return {
            error: "메인 비디오 트랙(Video Track 1)에 최소 하나 이상의 비디오 클립이 존재해야 합니다.",
            command: "",
            batContent: "",
            outputFile: ""
        };
    }

    // 프로젝트 전체 실제 재생 길이 계산 (가장 늦게 끝나는 클립의 종료 시점)
    let projectDuration = 0;
    clips.forEach(c => {
        const end = c.timelineStart + c.duration;
        if (end > projectDuration) projectDuration = end;
    });
    projectDuration = Math.max(0.1, parseFloat(projectDuration.toFixed(2)));

    let inputs = [];
    let rawInputs = [];
    let filterComplex = [];
    let currentInputIndex = 0;
    
    // 각 클립을 고유한 입력 번호로 매핑 (인풋 시킹 적용)
    // 1. Video Track 1 클립 입력 정의
    const video1Mappings = video1Clips.map((clip, index) => {
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
        const srcDur = clip.sourceEnd - clip.sourceStart;
        inputs.push(`-ss ${formatTime(clip.sourceStart)} -t ${formatTime(srcDur)} -i "${clip.localPath}"`);
        rawInputs.push({
            ss: formatTime(clip.sourceStart),
            t: formatTime(srcDur),
            path: clip.localPath
        });
        return { clip, inputIdx };
    });

    // 4. Overlay PNG 이미지 입력 정의 (텍스트 제외한 이미지 클립만)
    const imageClips = overlayClips.filter(c => c.overlayType === 'image');
    const imageMappings = imageClips.map((clip, index) => {
        const inputIdx = currentInputIndex++;
        inputs.push(`-i "${clip.localPath}"`);
        rawInputs.push({
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
        
        const vProcessed = `v1_proc_${inputIdx}`;
        const aProcessed = `a1_delayed_${inputIdx}`;
        
        filterComplex.push(`[${inputIdx}:v]${vFilters.join(",")}[${vProcessed}]`);
        filterComplex.push(`[${inputIdx}:a]${aFilters.join(",")}[${aProcessed}]`);
        
        // 베이스 캔버스 위에 타임라인 위치(timelineStart)에 맞게 오버레이
        const nextVideoNode = `v1_layer_${inputIdx}`;
        const endTimeline = clip.timelineStart + clip.duration;
        filterComplex.push(`[${currentVideoNode}][${vProcessed}]overlay=x=0:y=0:enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;
        
        audioMixInputs.push(`[${aProcessed}]`);
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
        
        vFilters.push(`fps=${outFPS}`);
        
        const vol = clip.volume !== undefined ? clip.volume : 1.0;
        aFilters.push(`volume=${vol}`);
        aFilters.push("aresample=44100");
        
        // 타임라인 위치에 맞추어 오디오 딜레이(adelay) 부여
        const delayMs = Math.round(clip.timelineStart * 1000);
        if (delayMs > 0) {
            aFilters.push(`adelay=${delayMs}|${delayMs}`);
        }
        
        const vProcessed = `v2_processed_${inputIdx}`;
        const aDelayed = `a2_delayed_${inputIdx}`;
        
        filterComplex.push(`[${inputIdx}:v]${vFilters.join(",")}[${vProcessed}]`);
        filterComplex.push(`[${inputIdx}:a]${aFilters.join(",")}[${aDelayed}]`);
        
        // 오버레이 합성 (출현 구간 설정)
        const nextVideoNode = `v_overlay_${inputIdx}`;
        const endTimeline = clip.timelineStart + clip.duration;
        filterComplex.push(`[${currentVideoNode}][${vProcessed}]overlay=x=${pipX}:y=${pipY}:enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;
        
        audioMixInputs.push(`[${aDelayed}]`);
    });
    
    // 3. Audio Track (BGM) 오디오 딜레이 및 믹싱 대기
    audioMappings.forEach((mapping, i) => {
        const { clip, inputIdx } = mapping;
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
    
    // 4. Overlay PNG 이미지 합성
    imageMappings.forEach((mapping, i) => {
        const { clip, inputIdx } = mapping;
        const scaleX = outW / 1280;
        const scaleY = outH / 720;
        const imgW = Math.round((clip.width || 100) * scaleX);
        const imgH = Math.round((clip.height || 100) * scaleY);
        const imgX = Math.round(clip.x * scaleX);
        const imgY = Math.round(clip.y * scaleY);
        
        const imgProcessed = `img_${inputIdx}`;
        filterComplex.push(`[${inputIdx}:v]scale=${imgW}:${imgH},setsar=1[${imgProcessed}]`);
        
        const nextVideoNode = `v_img_overlay_${inputIdx}`;
        const endTimeline = clip.timelineStart + clip.duration;
        filterComplex.push(`[${currentVideoNode}][${imgProcessed}]overlay=x=${imgX}:y=${imgY}:enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;
    });
    
    // 5. Overlay 텍스트 (자막) drawtext 필터 적용
    const textClips = overlayClips.filter(c => c.overlayType === 'text');
    textClips.forEach((clip, i) => {
        const endTimeline = clip.timelineStart + clip.duration;
        const scale = outW / 1280;
        const fontSize = Math.round((clip.textSize || 36) * scale);
        const fontColor = clip.textColor || "#ffffff";
        const fontPath = getFFmpegFontPath(clip.textFont || 'malgun', clip.textFontCustom);
        
        // 特수문자 escape
        let textEscaped = (clip.text || '')
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/:/g, '\\:')
            .replace(/%/g, '\\%');
            
        let textXExpr = clip.x === 640 ? "(w-text_w)/2" : `${Math.round(clip.x * (outW / 1280))}`;
        let textYExpr = `${Math.round(clip.y * (outH / 720))}`;
        
        const nextVideoNode = `v_text_overlay_${i}`;
        filterComplex.push(`[${currentVideoNode}]drawtext=text='${textEscaped}':x=${textXExpr}:y=${textYExpr}:fontsize=${fontSize}:fontcolor=${fontColor}:box=1:boxcolor=black@0.4:fontfile='${fontPath}':enable='between(t,${clip.timelineStart.toFixed(2)},${endTimeline.toFixed(2)})'[${nextVideoNode}]`);
        currentVideoNode = nextVideoNode;
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
    const outputFilename = `output\\rendered_${formatDateForFilename(new Date())}.mp4`;
    
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
function getFFmpegFontPath(textFont, textFontCustom) {
    if (textFont === 'custom' && textFontCustom) {
        let path = textFontCustom.replace(/\\/g, '/');
        if (path.substring(1, 3) === ':/') {
            path = path.charAt(0) + '\\:' + path.substring(2);
        }
        return path;
    }
    
    switch (textFont) {
        case 'gulim':
            return 'C\\:/Windows/Fonts/gulim.ttc';
        case 'batang':
            return 'C\\:/Windows/Fonts/batang.ttc';
        case 'arial':
            return 'C\\:/Windows/Fonts/arial.ttf';
        case 'malgun':
        default:
            return 'C\\:/Windows/Fonts/malgun.ttf';
    }
}
