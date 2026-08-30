/**
 * LookVideoEditor - Core Application Logic
 * 
 * 이 파일은 웹 동영상 편집기의 상태 관리, 타임라인 인터랙션,
 * 해상도 가변 실시간 브라우저 프리뷰(Canvas 렌더링), 프로젝트 파일(JSON) 입출력,
 * 그리고 원클릭 로컬 FFmpeg 및 브라우저 즉시 렌더링 파이프라인을 제어합니다.
 */

// --- 글로벌 애플리케이션 상태 (State) ---
const STATE = {
    assets: [],              // 가져온 소스 미디어 목록 ({ id, name, type, duration, url, file, localPath })
    clips: [],               // 타임라인에 배치된 개별 클립 목록
    selectedClipId: null,    // 현재 선택된 클립 ID
    playheadTime: 0,         // 현재 재생헤드 시간 (단위: 초)
    timelineZoom: 15,        // 줌 비율 (초당 픽셀 수, 기본 15px/s)
    isPlaying: false,        // 재생 여부
    totalDuration: 30,       // 타임라인 전체 길이 (가변적)
    previewVolume: 0.8,      // 프리뷰 음량
    isMuted: false,          // 프리뷰 음소거 상태
    lastAnimFrameId: null,   // requestAnimationFrame ID
    lastTimeUpdate: 0,       // 재생용 이전 타임스탬프
    outputWidth: 1920,       // 최종 비디오 출력 가로 크기
    outputHeight: 1080,      // 최종 비디오 출력 세로 크기
    outputFps: 30,           // 최종 비디오 출력 프레임 레이트
    encoder: 'h264_nvenc',   // 렌더링 인코더 (h264_nvenc: GPU, libx264: CPU)
    playerLastSeekTimes: {}, // 플레이어별 마지막 Seek 타임스탬프 (ms, 싱크 지터 방지)
    
    // 렌더링 상태
    renderPollingTimer: null,
    activeRenderOutput: null
};

// 비디오 효과 렌더링용 임시 버퍼 캔버스
const filterBufferCanvas = document.createElement('canvas');
const filterBufferCtx = filterBufferCanvas.getContext('2d');

// --- DOM 요소 캐싱 ---
const DOM = {
    btnNewProject: document.getElementById('btn-new-project'),
    btnLoadProject: document.getElementById('btn-load-project'),
    inputLoadProject: document.getElementById('input-load-project'),
    btnSaveProject: document.getElementById('btn-save-project'),
    btnRenderVideo: document.getElementById('btn-render-video'),
    
    inputMedia: document.getElementById('input-media'),
    mediaDropzone: document.getElementById('media-dropzone'),
    assetList: document.getElementById('asset-list'),
    
    previewCanvas: document.getElementById('preview-canvas'),
    previewCanvasWrapper: document.getElementById('preview-canvas-wrapper'),
    previewOverlay: document.getElementById('preview-overlay'),
    previewResolutionBadge: document.getElementById('preview-resolution-badge'),
    previewBadgeText: document.getElementById('preview-badge-text'),
    timeDisplay: document.getElementById('time-display'),
    btnPlay: document.getElementById('btn-player-play'),
    btnStop: document.getElementById('btn-player-stop'),
    btnPrevFrame: document.getElementById('btn-player-prev-frame'),
    btnNextFrame: document.getElementById('btn-player-next-frame'),
    btnMute: document.getElementById('btn-preview-mute'),
    previewVolumeSlider: document.getElementById('preview-volume'),
    
    timelineZoomSlider: document.getElementById('timeline-zoom'),
    zoomValueText: document.getElementById('zoom-value'),
    timelineScrollContainer: document.getElementById('timeline-scroll-container'),
    timelineRuler: document.getElementById('timeline-ruler'),
    playhead: document.getElementById('playhead'),
    trackVideo1: document.getElementById('lane-video1'),
    trackVideo2: document.getElementById('lane-video2'),
    trackAudio: document.getElementById('lane-audio'),
    trackOverlay: document.getElementById('lane-overlay'),
    btnAddTextClip: document.getElementById('btn-add-text-clip'),
    btnTimelineSplit: document.getElementById('btn-timeline-split'),
    btnTimelineClear: document.getElementById('btn-timeline-clear'),
    
    // 속성 제어 패널 관련
    propertiesEmptyMsg: document.getElementById('properties-empty-msg'),
    propertiesForm: document.getElementById('properties-form'),
    propClipTitle: document.getElementById('prop-clip-title'),
    propFileName: document.getElementById('prop-file-name'),
    propLocalPath: document.getElementById('prop-local-path'),
    propTimelineStart: document.getElementById('prop-timeline-start'),
    propDuration: document.getElementById('prop-duration'),
    propSourceStart: document.getElementById('prop-source-start'),
    propSourceEnd: document.getElementById('prop-source-end'),
    
    videoPropertiesSection: document.getElementById('video-properties-section'),
    pipPropertiesSection: document.getElementById('pip-properties-section'),
    audioPropertiesSection: document.getElementById('audio-properties-section'),
    overlayPropertiesSection: document.getElementById('overlay-properties-section'),
    textOverlaySection: document.getElementById('text-overlay-section'),
    imageOverlaySection: document.getElementById('image-overlay-section'),
    
    propRotation: document.getElementById('prop-rotation'),
    propVolume: document.getElementById('prop-volume'),
    propVolumeLabel: document.getElementById('prop-volume-label'),
    propSpeed: document.getElementById('prop-speed'),
    propSpeedLabel: document.getElementById('prop-speed-label'),
    speedPresets: document.querySelectorAll('.btn-preset'),
    propPipWidth: document.getElementById('prop-pip-width'),
    propPipHeight: document.getElementById('prop-pip-height'),
    propPipX: document.getElementById('prop-pip-x'),
    propPipY: document.getElementById('prop-pip-y'),
    propAudioVolume: document.getElementById('prop-audio-volume'),
    propAudioVolumeLabel: document.getElementById('prop-audio-volume-label'),
    propTextContent: document.getElementById('prop-text-content'),
    propTextSize: document.getElementById('prop-text-size'),
    propTextColor: document.getElementById('prop-text-color'),
    propTextFont: document.getElementById('prop-text-font'),
    propTextFontCustomGroup: document.getElementById('prop-text-font-custom-group'),
    propTextFontCustom: document.getElementById('prop-text-font-custom'),
    propImgWidth: document.getElementById('prop-img-width'),
    propImgHeight: document.getElementById('prop-img-height'),
    propTextX: document.getElementById('prop-text-x'),
    propTextY: document.getElementById('prop-text-y'),
    btnApplyProperties: document.getElementById('btn-apply-properties'),
    propVideoEffectsList: document.getElementById('prop-video-effects-list'),
    propEffectFadeOutGroup: document.getElementById('prop-effect-fade-out-group'),
    propFadeOutDuration: document.getElementById('prop-fade-out-duration'),
    propFadeOutLabel: document.getElementById('prop-fade-out-label'),
    fadeOutPresets: document.querySelectorAll('.btn-fade-preset'),
    btnDeleteClip: document.getElementById('btn-delete-clip'),
    
    hiddenPlayersContainer: document.getElementById('hidden-players-container'),
    
    projectResolution: document.getElementById('project-resolution'),
    projectFps: document.getElementById('project-fps'),
    projectEncoder: document.getElementById('project-encoder'),
    timelineFpsInfo: document.getElementById('timeline-fps-info'),

    // 렌더링 모달 요소
    renderModal: document.getElementById('render-modal'),
    renderModalTitle: document.getElementById('render-modal-title'),
    renderModalCloseBtn: document.getElementById('render-modal-close-btn'),
    renderStatusHeading: document.getElementById('render-status-heading'),
    renderStatusDesc: document.getElementById('render-status-desc'),
    renderSpinner: document.getElementById('render-spinner'),
    renderProgressBar: document.getElementById('render-progress-bar'),
    renderProgressPercent: document.getElementById('render-progress-percent'),
    renderProgressDetails: document.getElementById('render-progress-details'),
    renderMetaRes: document.getElementById('render-meta-res'),
    renderMetaFps: document.getElementById('render-meta-fps'),
    renderMetaEngine: document.getElementById('render-meta-engine'),
    renderMetaTime: document.getElementById('render-meta-time'),
    renderCompleteActions: document.getElementById('render-complete-actions'),
    renderOutputFilename: document.getElementById('render-output-filename'),
    btnCancelRender: document.getElementById('btn-cancel-render'),
    btnOpenRenderedFile: document.getElementById('btn-open-rendered-file'),
    btnOpenOutputFolder: document.getElementById('btn-open-output-folder'),
    btnDownloadRenderedVideo: document.getElementById('btn-download-rendered-video'),
    btnRenderDone: document.getElementById('btn-render-done')
};

// Canvas 컨텍스트 및 오버레이 버퍼 캐시
const ctx = DOM.previewCanvas.getContext('2d');
const activePlayers = {}; // assetId -> hidden DOM element (video/audio)

// --- 초기화 설정 ---
window.addEventListener('DOMContentLoaded', () => {
    initApp();
});

function initApp() {
    // 1. 해상도 및 캔버스 크기 초기화
    updatePreviewResolution();

    // 2. 이벤트 바인딩
    setupEventListeners();

    // 3. 초기 드로잉
    updateTimelineZoom();
    updatePlayheadPosition();
    drawRuler();
    renderPreview();

    // 4. 패널 크기 조절 기능 초기화
    initResizablePanels();
}

/**
 * 해상도 변경 시 실시간 브라우저 프리뷰 화면(Canvas 크기 및 종횡비) 동적 갱신
 */
function updatePreviewResolution() {
    if (DOM.projectResolution) {
        const resValue = DOM.projectResolution.value; // 예: "1920x1080", "1080x1920"
        const parts = resValue.split('x');
        STATE.outputWidth = parseInt(parts[0]) || 1920;
        STATE.outputHeight = parseInt(parts[1]) || 1080;
    }
    if (DOM.projectFps) {
        STATE.outputFps = parseInt(DOM.projectFps.value) || 30;
    }
    if (DOM.projectEncoder) {
        STATE.encoder = DOM.projectEncoder.value;
    }

    // 캔버스의 내부 픽셀 해상도 갱신
    DOM.previewCanvas.width = STATE.outputWidth;
    DOM.previewCanvas.height = STATE.outputHeight;
    DOM.previewCanvas.style.aspectRatio = `${STATE.outputWidth} / ${STATE.outputHeight}`;

    // 상단 및 타임라인 해상도 정보 뱃지 갱신
    let aspectText = "16:9";
    if (STATE.outputWidth === 1080 && STATE.outputHeight === 1920) aspectText = "세로 9:16";
    else if (STATE.outputWidth === STATE.outputHeight) aspectText = "1:1";
    
    if (DOM.previewBadgeText) {
        DOM.previewBadgeText.textContent = `${STATE.outputWidth} x ${STATE.outputHeight} (${aspectText})`;
    }
    if (DOM.timelineFpsInfo) {
        DOM.timelineFpsInfo.innerHTML = `<i class="fa-solid fa-film"></i> ${STATE.outputWidth}x${STATE.outputHeight} ${STATE.outputFps}fps`;
    }

    // 프리뷰 즉시 다시 그리기
    renderPreview();
}

function setupEventListeners() {
    // 미디어 가져오기 이벤트
    DOM.mediaDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        DOM.mediaDropzone.classList.add('dragover');
    });
    DOM.mediaDropzone.addEventListener('dragleave', () => {
        DOM.mediaDropzone.classList.remove('dragover');
    });
    DOM.mediaDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        DOM.mediaDropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleMediaImport(e.dataTransfer.files);
        }
    });
    DOM.inputMedia.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleMediaImport(e.target.files);
            e.target.value = '';
        }
    });

    // 프로젝트 관리 이벤트
    DOM.btnNewProject.addEventListener('click', confirmNewProject);
    DOM.btnLoadProject.addEventListener('click', () => DOM.inputLoadProject.click());
    DOM.inputLoadProject.addEventListener('change', loadProjectFile);
    DOM.btnSaveProject.addEventListener('click', saveProjectFile);
    
    // 원클릭 '렌더링 하기' 즉시 렌더링 이벤트
    DOM.btnRenderVideo.addEventListener('click', startDirectRendering);

    // 렌더링 모달 제어 이벤트
    if (DOM.renderModalCloseBtn) DOM.renderModalCloseBtn.addEventListener('click', closeRenderModal);
    if (DOM.btnCancelRender) DOM.btnCancelRender.addEventListener('click', cancelRendering);
    if (DOM.btnOpenRenderedFile) DOM.btnOpenRenderedFile.addEventListener('click', openRenderedVideoFile);
    if (DOM.btnOpenOutputFolder) DOM.btnOpenOutputFolder.addEventListener('click', openOutputFolder);
    if (DOM.btnRenderDone) DOM.btnRenderDone.addEventListener('click', closeRenderModal);

    // 플레이어 제어 이벤트
    DOM.btnPlay.addEventListener('click', togglePlayback);
    DOM.btnStop.addEventListener('click', stopPlayback);
    DOM.btnPrevFrame.addEventListener('click', () => stepFrame(-0.05));
    DOM.btnNextFrame.addEventListener('click', () => stepFrame(0.05));
    
    DOM.btnMute.addEventListener('click', toggleMute);
    DOM.previewVolumeSlider.addEventListener('input', (e) => {
        STATE.previewVolume = parseFloat(e.target.value);
        STATE.isMuted = STATE.previewVolume === 0;
        updateMuteUI();
        updateActivePlayersVolumes();
    });

    // 툴바 이벤트
    DOM.timelineZoomSlider.addEventListener('input', (e) => {
        STATE.timelineZoom = parseInt(e.target.value);
        updateTimelineZoom();
    });
    
    DOM.btnAddTextClip.addEventListener('click', addTextOverlayClip);
    DOM.btnTimelineSplit.addEventListener('click', splitSelectedClip);
    DOM.btnTimelineClear.addEventListener('click', clearTimeline);
    
    // 단축키 매핑 (S: 분할, Space: 재생/일시정지, Delete: 선택된 클립 삭제)
    window.addEventListener('keydown', (e) => {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
            return;
        }
        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayback();
        } else if (e.code === 'KeyS') {
            e.preventDefault();
            splitSelectedClip();
        } else if (e.code === 'Delete') {
            e.preventDefault();
            if (STATE.selectedClipId) {
                deleteClip(STATE.selectedClipId);
            }
        }
    });

    // 타임라인 눈금자(Ruler) 드래그 및 스크러빙
    let isScrubbing = false;
    DOM.timelineRuler.addEventListener('mousedown', (e) => {
        isScrubbing = true;
        scrub(e);
    });
    window.addEventListener('mousemove', (e) => {
        if (isScrubbing) scrub(e);
    });
    window.addEventListener('mouseup', () => {
        isScrubbing = false;
    });

    // 타임라인 트랙 빈 영역 클릭 및 스크러빙
    const timelineLanes = [DOM.trackVideo1, DOM.trackVideo2, DOM.trackAudio, DOM.trackOverlay];
    timelineLanes.forEach(lane => {
        if (lane) {
            lane.addEventListener('mousedown', (e) => {
                if (e.target === lane) {
                    isScrubbing = true;
                    scrub(e);
                }
            });
        }
    });

    // 재생헤드 다이아몬드 핸들 드래그 연동
    let isDraggingPlayhead = false;
    const playheadHandle = document.querySelector('.playhead-handle');
    if (playheadHandle) {
        playheadHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isDraggingPlayhead = true;
        });
        window.addEventListener('mousemove', (e) => {
            if (isDraggingPlayhead) {
                scrub(e);
            }
        });
        window.addEventListener('mouseup', () => {
            isDraggingPlayhead = false;
        });
    }

    // 속성 패널 컨트롤러 실시간 값 감지 및 자동 저장 반영
    const propInputs = [
        DOM.propLocalPath, DOM.propTimelineStart, DOM.propDuration,
        DOM.propSourceStart, DOM.propSourceEnd, DOM.propRotation,
        DOM.propVolume, DOM.propSpeed, DOM.propPipWidth, DOM.propPipHeight,
        DOM.propPipX, DOM.propPipY, DOM.propAudioVolume,
        DOM.propTextContent, DOM.propTextSize, DOM.propTextColor,
        DOM.propTextFont, DOM.propTextFontCustom,
        DOM.propImgWidth, DOM.propImgHeight, DOM.propTextX, DOM.propTextY,
        DOM.propFadeOutDuration
    ];
    propInputs.forEach(input => {
        if (input) {
            input.addEventListener('input', updateSelectedClipFromInputs);
            input.addEventListener('change', updateSelectedClipFromInputs);
        }
    });

    // 배속 프리셋 버튼 이벤트 바인딩
    if (DOM.speedPresets) {
        DOM.speedPresets.forEach(btn => {
            btn.addEventListener('click', () => {
                if (DOM.propSpeed) {
                    DOM.propSpeed.value = btn.dataset.speed;
                    DOM.propSpeed.dispatchEvent(new Event('input', { bubbles: true }));
                    DOM.propSpeed.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });
    }

    // 페이드아웃 지속 시간 프리셋 버튼 이벤트 바인딩
    if (DOM.fadeOutPresets) {
        DOM.fadeOutPresets.forEach(btn => {
            btn.addEventListener('click', () => {
                if (DOM.propFadeOutDuration) {
                    DOM.propFadeOutDuration.value = btn.dataset.fade;
                    DOM.propFadeOutDuration.dispatchEvent(new Event('input', { bubbles: true }));
                    DOM.propFadeOutDuration.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });
    }

    // 폰트 셀렉트 체인지에 따른 직접입력 창 토글
    if (DOM.propTextFont) {
        DOM.propTextFont.addEventListener('change', (e) => {
            if (e.target.value === 'custom') {
                DOM.propTextFontCustomGroup.classList.remove('hide');
            } else {
                DOM.propTextFontCustomGroup.classList.add('hide');
            }
            updateSelectedClipFromInputs();
        });
    }

    DOM.btnApplyProperties.addEventListener('click', applyPropertiesChanges);
    DOM.btnDeleteClip.addEventListener('click', () => {
        if (STATE.selectedClipId) {
            deleteClip(STATE.selectedClipId);
        }
    });

    // 타임라인 레인 드래그 오버
    const lanes = [DOM.trackVideo1, DOM.trackVideo2, DOM.trackAudio, DOM.trackOverlay];
    lanes.forEach(lane => {
        lane.addEventListener('dragover', (e) => {
            e.preventDefault();
            lane.classList.add('dragover-lane');
        });
        lane.addEventListener('dragleave', () => {
            lane.classList.remove('dragover-lane');
        });
        lane.addEventListener('drop', (e) => {
            lane.classList.remove('dragover-lane');
            e.preventDefault();
            
            const assetId = e.dataTransfer.getData('text/plain');
            const targetTrack = lane.parentElement.dataset.trackType;
            if (assetId) {
                const rect = lane.getBoundingClientRect();
                const dropX = e.clientX - rect.left + lane.scrollLeft;
                const timelineStart = Math.max(0, dropX / STATE.timelineZoom);
                addAssetToTimeline(assetId, targetTrack, timelineStart);
            }
        });
    });

    // 프로젝트 출력 설정 변경 감지 -> 실시간 프리뷰 화면 자동 맞춤 갱신
    if (DOM.projectResolution) {
        DOM.projectResolution.addEventListener('change', updatePreviewResolution);
    }
    if (DOM.projectFps) {
        DOM.projectFps.addEventListener('change', updatePreviewResolution);
    }
    if (DOM.projectEncoder) {
        DOM.projectEncoder.addEventListener('change', updatePreviewResolution);
    }

    // 타임라인 가로 스크롤 시 눈금자 실시간 리렌더링
    if (DOM.timelineScrollContainer) {
        DOM.timelineScrollContainer.addEventListener('scroll', drawRuler);
    }

    // 효과 라이브러리 드래그 및 클릭 이벤트 설정
    document.querySelectorAll('.effect-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/effect', item.dataset.effect);
        });
        item.addEventListener('click', () => {
            const effect = item.dataset.effect;
            if (STATE.selectedClipId) {
                const clip = STATE.clips.find(c => c.id === STATE.selectedClipId);
                if (clip && (clip.track === 'video1' || clip.track === 'video2')) {
                    if (!clip.effects) clip.effects = [];
                    if (!clip.effects.includes(effect)) {
                        clip.effects.push(effect);
                        if (effect === 'fade_out' && clip.fadeOutDuration === undefined) {
                            clip.fadeOutDuration = 0.5;
                        }
                    }
                    selectClip(clip.id);
                    renderPreview();
                } else {
                    alert("비디오 트랙의 클립을 선택한 후 효과를 클릭하거나, 원하는 클립 위로 효과를 드래그하세요.");
                }
            } else {
                alert("효과를 적용할 타임라인 클립을 먼저 선택하거나, 클립 위로 직접 드래그하세요.");
            }
        });
    });
}

// --- 미디어 파일 임포트 로직 ---
function handleMediaImport(files) {
    DOM.previewOverlay.classList.remove('hide');
    
    const safetyTimeout = setTimeout(() => {
        if (!DOM.previewOverlay.classList.contains('hide')) {
            DOM.previewOverlay.classList.add('hide');
            updateAssetListUI();
            updateTimelineClipsUI();
            renderPreview();
        }
    }, 6000);
    
    Array.from(files).forEach(file => {
        let type = 'video';
        const fileNameLower = file.name.toLowerCase();
        
        if (file.type.startsWith('audio/') || 
            fileNameLower.endsWith('.mp3') || 
            fileNameLower.endsWith('.wav') || 
            fileNameLower.endsWith('.m4a') || 
            fileNameLower.endsWith('.aac') || 
            fileNameLower.endsWith('.flac') || 
            fileNameLower.endsWith('.wma') || 
            fileNameLower.endsWith('.ogg')) {
            type = 'audio';
        } else if (file.type.startsWith('image/') || 
                   fileNameLower.endsWith('.png') || 
                   fileNameLower.endsWith('.jpg') || 
                   fileNameLower.endsWith('.jpeg')) {
            type = 'image';
        }

        const url = URL.createObjectURL(file);
        
        let existingAsset = STATE.assets.find(a => a.name.toLowerCase() === file.name.toLowerCase() && !a.url);
        if (!existingAsset) {
            existingAsset = STATE.assets.find(a => a.name.toLowerCase() === file.name.toLowerCase());
        }

        let asset = existingAsset;
        if (!existingAsset) {
            const id = 'asset_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
            const localPath = `D:\\Study\\WebPage\\LookVideoEditor\\source\\${file.name}`;
            asset = {
                id,
                name: file.name,
                type,
                duration: 5.0,
                url,
                file,
                localPath
            };
            STATE.assets.push(asset);
        } else {
            asset.url = url;
            asset.file = file;
        }

        // 숨김 플레이어 생성하여 메타데이터(지속 시간) 로드
        if (type === 'video') {
            const video = document.createElement('video');
            video.src = url;
            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;
            
            video.onloadedmetadata = () => {
                asset.duration = video.duration || 10.0;
                clearTimeout(safetyTimeout);
                DOM.previewOverlay.classList.add('hide');
                updateAssetListUI();
                updateTimelineClipsUI();
                renderPreview();
            };
            video.onerror = () => {
                console.warn("[LookVideoEditor] 비디오 프리뷰 포맷 미지원:", file.name);
                asset.isPreviewDisabled = true;
                clearTimeout(safetyTimeout);
                DOM.previewOverlay.classList.add('hide');
                updateAssetListUI();
            };
            DOM.hiddenPlayersContainer.appendChild(video);
            activePlayers[asset.id] = video;
        } else if (type === 'audio') {
            const audio = document.createElement('audio');
            audio.src = url;
            audio.preload = 'metadata';
            
            audio.onloadedmetadata = () => {
                asset.duration = audio.duration || 10.0;
                clearTimeout(safetyTimeout);
                DOM.previewOverlay.classList.add('hide');
                updateAssetListUI();
                updateTimelineClipsUI();
            };
            audio.onerror = () => {
                clearTimeout(safetyTimeout);
                DOM.previewOverlay.classList.add('hide');
                updateAssetListUI();
            };
            DOM.hiddenPlayersContainer.appendChild(audio);
            activePlayers[asset.id] = audio;
        } else {
            // 이미지 에셋
            clearTimeout(safetyTimeout);
            DOM.previewOverlay.classList.add('hide');
            updateAssetListUI();
        }
    });

    updateAssetListUI();
}

// 좌측 미디어 리스트 UI 갱신
function updateAssetListUI() {
    DOM.assetList.innerHTML = '';
    
    if (STATE.assets.length === 0) {
        DOM.assetList.innerHTML = '<li class="empty-list-msg">미디어 파일이 없습니다.</li>';
        return;
    }

    STATE.assets.forEach(asset => {
        const li = document.createElement('li');
        li.className = `asset-item type-${asset.type}`;
        li.draggable = true;
        li.dataset.assetId = asset.id;
        
        let iconClass = 'fa-video';
        if (asset.type === 'audio') iconClass = 'fa-music';
        else if (asset.type === 'image') iconClass = 'fa-image';

        li.innerHTML = `
            <i class="fa-solid ${iconClass} asset-icon"></i>
            <div class="asset-info">
                <div class="asset-name" title="${asset.name}">${asset.name}</div>
                <div class="asset-duration">${asset.type === 'image' ? '이미지' : formatTimeShort(asset.duration)}</div>
            </div>
        `;

        li.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', asset.id);
        });

        DOM.assetList.appendChild(li);
    });
}

// 타임라인에 에셋 클립 추가
function addAssetToTimeline(assetId, trackType, timelineStart) {
    const asset = STATE.assets.find(a => a.id === assetId);
    if (!asset) return;

    // 트랙 타입 유효성 검사
    if (asset.type === 'video' && (trackType !== 'video1' && trackType !== 'video2')) {
        alert("비디오 파일은 Video Track 1 또는 Video Track 2(PIP)에만 배치할 수 있습니다.");
        return;
    }
    if (asset.type === 'audio' && trackType !== 'audio') {
        alert("오디오 파일은 Audio Track에만 배치할 수 있습니다.");
        return;
    }
    if (asset.type === 'image' && trackType !== 'overlay') {
        alert("이미지 스티커는 Overlay Track에만 배치할 수 있습니다.");
        return;
    }

    const clipId = 'clip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const duration = asset.type === 'image' ? 5.0 : Math.min(asset.duration, 10.0);
    
    // 기본 클립 객체 정의
    const newClip = {
        id: clipId,
        assetId: asset.id,
        name: asset.name,
        localPath: asset.localPath,
        track: trackType,
        timelineStart: parseFloat(timelineStart.toFixed(2)),
        duration: parseFloat(duration.toFixed(2)),
        sourceStart: 0,
        sourceEnd: parseFloat(duration.toFixed(2)),
        rotation: 0,
        volume: 1.0,
        speed: 1.0,
        effects: []
    };

    if (trackType === 'video2') {
        // PIP 기본 크기 및 좌표 (1280x720 기준)
        newClip.pip = { width: 320, height: 180, x: 20, y: 20 };
    } else if (trackType === 'overlay' && asset.type === 'image') {
        newClip.overlayType = 'image';
        newClip.width = 150;
        newClip.height = 150;
        newClip.x = 640;
        newClip.y = 360;
    }

    STATE.clips.push(newClip);
    selectClip(clipId);
    
    updateTimelineClipsUI();
    recalculateTotalDuration();
    renderPreview();
}

// 텍스트(자막) 오버레이 클립 추가
function addTextOverlayClip() {
    const clipId = 'clip_txt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const timelineStart = STATE.playheadTime;
    const duration = 4.0;

    const newClip = {
        id: clipId,
        name: '자막 텍스트',
        localPath: '',
        track: 'overlay',
        overlayType: 'text',
        timelineStart: parseFloat(timelineStart.toFixed(2)),
        duration: duration,
        sourceStart: 0,
        sourceEnd: duration,
        text: '새로운 자막 텍스트',
        textSize: 36,
        textColor: '#ffffff',
        textFont: 'malgun',
        textFontCustom: '',
        x: 640, // 가로 중앙 (1280x720 기준)
        y: 600  // 하단
    };

    STATE.clips.push(newClip);
    selectClip(clipId);
    
    updateTimelineClipsUI();
    recalculateTotalDuration();
    renderPreview();
}

// 타임라인 클립 UI 렌더링
function updateTimelineClipsUI() {
    DOM.trackVideo1.innerHTML = '';
    DOM.trackVideo2.innerHTML = '';
    DOM.trackAudio.innerHTML = '';
    DOM.trackOverlay.innerHTML = '';

    STATE.clips.forEach(clip => {
        let lane = DOM.trackVideo1;
        if (clip.track === 'video2') lane = DOM.trackVideo2;
        else if (clip.track === 'audio') lane = DOM.trackAudio;
        else if (clip.track === 'overlay') lane = DOM.trackOverlay;

        const clipEl = document.createElement('div');
        clipEl.className = `timeline-clip type-${clip.track}`;
        if (clip.id === STATE.selectedClipId) {
            clipEl.classList.add('selected');
        }
        clipEl.dataset.clipId = clip.id;

        const left = clip.timelineStart * STATE.timelineZoom;
        const width = clip.duration * STATE.timelineZoom;

        clipEl.style.left = `${left}px`;
        clipEl.style.width = `${width}px`;

        let speedBadgeHtml = '';
        if (clip.speed && Math.abs(clip.speed - 1.0) > 0.01) {
            speedBadgeHtml = `<span class="clip-speed-badge">${clip.speed.toFixed(1)}x</span>`;
        }

        let displayName = clip.name;
        if (clip.overlayType === 'text') displayName = clip.text || '자막 텍스트';

        clipEl.innerHTML = `
            <div class="trim-handle trim-handle-left" data-handle="left"></div>
            <span class="clip-name">${displayName}</span>
            ${speedBadgeHtml}
            <span class="clip-duration-info">${clip.duration.toFixed(1)}s [${clip.sourceStart.toFixed(1)}~${clip.sourceEnd.toFixed(1)}]</span>
            <div class="trim-handle trim-handle-right" data-handle="right"></div>
        `;

        // 클립 선택 및 드래그 이동
        clipEl.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('trim-handle')) return;
            e.stopPropagation();
            selectClip(clip.id);
            initClipDrag(e, clip);
        });

        // 좌/우 트리밍 핸들 드래그
        const leftHandle = clipEl.querySelector('.trim-handle-left');
        const rightHandle = clipEl.querySelector('.trim-handle-right');
        
        leftHandle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            selectClip(clip.id);
            initClipTrim(e, clip, 'left');
        });
        
        rightHandle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            selectClip(clip.id);
            initClipTrim(e, clip, 'right');
        });

        // 효과 아이콘 드롭 수신
        clipEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            clipEl.style.filter = 'brightness(1.3)';
        });
        clipEl.addEventListener('dragleave', () => {
            clipEl.style.filter = '';
        });
        clipEl.addEventListener('drop', (e) => {
            e.preventDefault();
            clipEl.style.filter = '';
            const effect = e.dataTransfer.getData('text/effect');
            if (effect && (clip.track === 'video1' || clip.track === 'video2')) {
                if (!clip.effects) clip.effects = [];
                if (!clip.effects.includes(effect)) {
                    clip.effects.push(effect);
                    if (effect === 'fade_out' && clip.fadeOutDuration === undefined) {
                        clip.fadeOutDuration = 0.5;
                    }
                    selectClip(clip.id);
                    renderPreview();
                }
            }
        });

        lane.appendChild(clipEl);
    });
}

// 클립 선택
function selectClip(clipId) {
    STATE.selectedClipId = clipId;
    
    // UI 상의 선택 표시 갱신
    document.querySelectorAll('.timeline-clip').forEach(el => {
        if (el.dataset.clipId === clipId) el.classList.add('selected');
        else el.classList.remove('selected');
    });

    if (!clipId) {
        DOM.propertiesEmptyMsg.classList.remove('hide');
        DOM.propertiesForm.classList.add('hide');
        return;
    }

    const clip = STATE.clips.find(c => c.id === clipId);
    if (!clip) return;

    DOM.propertiesEmptyMsg.classList.add('hide');
    DOM.propertiesForm.classList.remove('hide');

    // 기본 속성 채우기
    DOM.propFileName.value = clip.name || '';
    DOM.propLocalPath.value = clip.localPath || '';
    DOM.propTimelineStart.value = clip.timelineStart;
    DOM.propDuration.value = clip.duration;
    DOM.propSourceStart.value = clip.sourceStart;
    DOM.propSourceEnd.value = clip.sourceEnd;

    // 섹션별 가시성 토글
    DOM.videoPropertiesSection.classList.add('hide');
    DOM.audioPropertiesSection.classList.add('hide');
    DOM.overlayPropertiesSection.classList.add('hide');
    DOM.pipPropertiesSection.classList.add('hide');
    DOM.textOverlaySection.classList.add('hide');
    DOM.imageOverlaySection.classList.add('hide');

    if (clip.track === 'video1' || clip.track === 'video2') {
        DOM.propClipTitle.textContent = clip.track === 'video1' ? "메인 비디오 클립" : "PIP 비디오 클립";
        DOM.videoPropertiesSection.classList.remove('hide');
        DOM.propRotation.value = clip.rotation || 0;
        DOM.propVolume.value = clip.volume !== undefined ? clip.volume : 1.0;
        DOM.propVolumeLabel.textContent = Math.round((clip.volume !== undefined ? clip.volume : 1.0) * 100);
        
        const speed = clip.speed || 1.0;
        DOM.propSpeed.value = speed;
        DOM.propSpeedLabel.textContent = speed.toFixed(1);

        if (clip.track === 'video2') {
            DOM.pipPropertiesSection.classList.remove('hide');
            const pip = clip.pip || { width: 320, height: 180, x: 20, y: 20 };
            DOM.propPipWidth.value = pip.width;
            DOM.propPipHeight.value = pip.height;
            DOM.propPipX.value = pip.x;
            DOM.propPipY.value = pip.y;
        }

        // 효과 배지 리스트
        DOM.propVideoEffectsList.innerHTML = '';
        const hasFadeOut = clip.effects && clip.effects.includes('fade_out');
        if (DOM.propEffectFadeOutGroup) {
            if (hasFadeOut) {
                DOM.propEffectFadeOutGroup.classList.remove('hide');
                const fadeDur = clip.fadeOutDuration !== undefined ? clip.fadeOutDuration : 0.5;
                if (DOM.propFadeOutDuration) DOM.propFadeOutDuration.value = fadeDur;
                if (DOM.propFadeOutLabel) DOM.propFadeOutLabel.textContent = `${fadeDur.toFixed(1)}s`;
            } else {
                DOM.propEffectFadeOutGroup.classList.add('hide');
            }
        }

        if (clip.effects && clip.effects.length > 0) {
            clip.effects.forEach(eff => {
                const badge = document.createElement('div');
                badge.className = 'effect-badge';
                if (eff === 'fade_out') {
                    badge.classList.add('effect-badge-clickable');
                    badge.title = '클릭하여 페이드아웃 설정 조절';
                }
                badge.innerHTML = `<span>${getEffectName(eff)}</span> <i class="fa-solid fa-xmark remove-effect" data-effect="${eff}"></i>`;
                badge.addEventListener('click', (e) => {
                    if (e.target.classList.contains('remove-effect')) return;
                    if (eff === 'fade_out' && DOM.propEffectFadeOutGroup) {
                        DOM.propEffectFadeOutGroup.classList.remove('hide');
                        if (DOM.propFadeOutDuration) DOM.propFadeOutDuration.focus();
                    }
                });
                badge.querySelector('.remove-effect').addEventListener('click', (e) => {
                    e.stopPropagation();
                    clip.effects = clip.effects.filter(e => e !== eff);
                    selectClip(clip.id);
                    renderPreview();
                });
                DOM.propVideoEffectsList.appendChild(badge);
            });
        }
    } else if (clip.track === 'audio') {
        DOM.propClipTitle.textContent = "배경음악 오디오 클립";
        DOM.audioPropertiesSection.classList.remove('hide');
        DOM.propAudioVolume.value = clip.volume !== undefined ? clip.volume : 1.0;
        DOM.propAudioVolumeLabel.textContent = Math.round((clip.volume !== undefined ? clip.volume : 1.0) * 100);
    } else if (clip.track === 'overlay') {
        DOM.overlayPropertiesSection.classList.remove('hide');
        DOM.propTextX.value = clip.x || 0;
        DOM.propTextY.value = clip.y || 0;
        
        if (clip.overlayType === 'text') {
            DOM.propClipTitle.textContent = "자막 (텍스트 오버레이)";
            DOM.textOverlaySection.classList.remove('hide');
            DOM.propTextContent.value = clip.text || '';
            DOM.propTextSize.value = clip.textSize || 36;
            DOM.propTextColor.value = clip.textColor || '#ffffff';
            DOM.propTextFont.value = clip.textFont || 'malgun';
            DOM.propTextFontCustom.value = clip.textFontCustom || '';
            if (clip.textFont === 'custom') {
                DOM.propTextFontCustomGroup.classList.remove('hide');
            } else {
                DOM.propTextFontCustomGroup.classList.add('hide');
            }
        } else if (clip.overlayType === 'image') {
            DOM.propClipTitle.textContent = "PNG 스티커 (이미지 오버레이)";
            DOM.imageOverlaySection.classList.remove('hide');
            DOM.propImgWidth.value = clip.width || 150;
            DOM.propImgHeight.value = clip.height || 150;
        }
    }
}

function getEffectName(effectKey) {
    switch (effectKey) {
        case 'sepia': return '세피아';
        case 'grayscale': return '흑백';
        case 'reverse': return '리버스';
        case 'zoom_in': return '줌인';
        case 'zoom_out': return '줌아웃';
        case 'fade_out': return '페이드아웃';
        default: return effectKey;
    }
}

// 속성 변경 사항 실시간 적용
function updateSelectedClipFromInputs(e) {
    if (!STATE.selectedClipId) return;
    const clip = STATE.clips.find(c => c.id === STATE.selectedClipId);
    if (!clip) return;

    clip.localPath = DOM.propLocalPath.value;
    
    const speed = DOM.propSpeed ? (parseFloat(DOM.propSpeed.value) || 1.0) : 1.0;
    clip.speed = speed;
    if (DOM.propSpeedLabel) DOM.propSpeedLabel.textContent = speed.toFixed(1);
    
    const timelineStart = parseFloat(DOM.propTimelineStart.value) || 0;
    clip.timelineStart = timelineStart;
    
    const asset = clip.assetId ? STATE.assets.find(a => a.id === clip.assetId) : null;
    const assetDuration = asset ? asset.duration : 1000.0;

    if (e && e.target === DOM.propSpeed) {
        const sourceDur = clip.sourceEnd - clip.sourceStart;
        clip.duration = parseFloat((sourceDur / speed).toFixed(2));
        DOM.propDuration.value = clip.duration;
    } else if (e && e.target === DOM.propDuration) {
        const duration = parseFloat(DOM.propDuration.value) || 0.1;
        clip.sourceEnd = Math.min(assetDuration, clip.sourceStart + duration * speed);
        clip.duration = parseFloat(((clip.sourceEnd - clip.sourceStart) / speed).toFixed(2));
        DOM.propSourceEnd.value = clip.sourceEnd;
    } else if (e && (e.target === DOM.propSourceStart || e.target === DOM.propSourceEnd)) {
        const sourceStart = parseFloat(DOM.propSourceStart.value) || 0;
        const sourceEnd = parseFloat(DOM.propSourceEnd.value) || 0.1;
        clip.sourceStart = Math.min(assetDuration, sourceStart);
        clip.sourceEnd = Math.min(assetDuration, Math.max(clip.sourceStart + 0.1, sourceEnd));
        clip.duration = parseFloat(((clip.sourceEnd - clip.sourceStart) / speed).toFixed(2));
        DOM.propSourceStart.value = clip.sourceStart;
        DOM.propSourceEnd.value = clip.sourceEnd;
        DOM.propDuration.value = clip.duration;
    } else {
        const sourceStart = parseFloat(DOM.propSourceStart.value) || 0;
        const sourceEnd = parseFloat(DOM.propSourceEnd.value) || 0.1;
        clip.sourceStart = sourceStart;
        clip.sourceEnd = sourceEnd;
        if (!e) {
            clip.duration = parseFloat(((clip.sourceEnd - clip.sourceStart) / speed).toFixed(2));
            DOM.propDuration.value = clip.duration;
        } else {
            clip.duration = parseFloat(DOM.propDuration.value) || 0.1;
        }
    }

    if (clip.track === 'video1' || clip.track === 'video2') {
        clip.rotation = parseInt(DOM.propRotation.value);
        clip.volume = parseFloat(DOM.propVolume.value);
        DOM.propVolumeLabel.textContent = Math.round(clip.volume * 100);
        
        if (DOM.propFadeOutDuration) {
            const fadeDur = parseFloat(DOM.propFadeOutDuration.value) || 0.5;
            clip.fadeOutDuration = fadeDur;
            if (DOM.propFadeOutLabel) DOM.propFadeOutLabel.textContent = `${fadeDur.toFixed(1)}s`;
        }
        
        if (clip.track === 'video2') {
            clip.pip = {
                width: parseInt(DOM.propPipWidth.value) || 320,
                height: parseInt(DOM.propPipHeight.value) || 180,
                x: parseInt(DOM.propPipX.value) || 0,
                y: parseInt(DOM.propPipY.value) || 0
            };
        }
    } else if (clip.track === 'audio') {
        clip.volume = parseFloat(DOM.propAudioVolume.value);
        DOM.propAudioVolumeLabel.textContent = Math.round(clip.volume * 100);
    } else if (clip.track === 'overlay') {
        clip.x = parseInt(DOM.propTextX.value) || 0;
        clip.y = parseInt(DOM.propTextY.value) || 0;
        
        if (clip.overlayType === 'text') {
            clip.text = DOM.propTextContent.value;
            clip.textSize = parseInt(DOM.propTextSize.value) || 36;
            clip.textColor = DOM.propTextColor.value;
            clip.textFont = DOM.propTextFont.value;
            clip.textFontCustom = DOM.propTextFontCustom.value;
        } else if (clip.overlayType === 'image') {
            clip.width = parseInt(DOM.propImgWidth.value) || 150;
            clip.height = parseInt(DOM.propImgHeight.value) || 150;
        }
    }

    updateTimelineClipsUIOnlyPosition();
    renderPreview();
}

function updateTimelineClipsUIOnlyPosition() {
    STATE.clips.forEach(clip => {
        const el = document.querySelector(`.timeline-clip[data-clip-id="${clip.id}"]`);
        if (el) {
            const left = clip.timelineStart * STATE.timelineZoom;
            const width = clip.duration * STATE.timelineZoom;
            el.style.left = `${left}px`;
            el.style.width = `${width}px`;
            el.querySelector('.clip-duration-info').textContent = `${clip.duration.toFixed(1)}s [${clip.sourceStart.toFixed(1)}~${clip.sourceEnd.toFixed(1)}]`;
            if (clip.overlayType === 'text') {
                el.querySelector('.clip-name').textContent = clip.text || '자막 텍스트';
            }
        }
    });
}

function applyPropertiesChanges() {
    updateTimelineClipsUI();
    recalculateTotalDuration();
    renderPreview();
}

// 클립 삭제
function deleteClip(clipId) {
    STATE.clips = STATE.clips.filter(c => c.id !== clipId);
    STATE.selectedClipId = null;
    selectClip(null);
    updateTimelineClipsUI();
    recalculateTotalDuration();
    renderPreview();
}

// 클립 분할 (Split)
function splitSelectedClip() {
    if (!STATE.selectedClipId) return;
    const clip = STATE.clips.find(c => c.id === STATE.selectedClipId);
    if (!clip) return;

    const splitTime = STATE.playheadTime;
    if (splitTime <= clip.timelineStart || splitTime >= clip.timelineStart + clip.duration) {
        alert("재생헤드가 선택된 클립 영역 중간에 위치해 있어야 분할이 가능합니다.");
        return;
    }

    const speed = clip.speed || 1.0;
    const firstPartDuration = splitTime - clip.timelineStart;
    const secondPartDuration = clip.timelineStart + clip.duration - splitTime;
    const originalSourceEnd = clip.sourceEnd;
    
    // 1. 기존 클립 앞부분으로 변경
    clip.sourceEnd = parseFloat((clip.sourceStart + firstPartDuration * speed).toFixed(2));
    clip.duration = parseFloat(firstPartDuration.toFixed(2));

    // 2. 뒷부분 새 클립 생성
    const newId = 'clip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const newClip = {
        ...JSON.parse(JSON.stringify(clip)),
        id: newId,
        timelineStart: parseFloat(splitTime.toFixed(2)),
        duration: parseFloat(secondPartDuration.toFixed(2)),
        sourceStart: parseFloat((clip.sourceEnd).toFixed(2)),
        sourceEnd: parseFloat(originalSourceEnd.toFixed(2))
    };

    STATE.clips.push(newClip);
    selectClip(newId);
    
    updateTimelineClipsUI();
    recalculateTotalDuration();
    renderPreview();
}

// 타임라인 초기화
function clearTimeline() {
    if (confirm("정말로 타임라인의 모든 클립을 삭제하시겠습니까?")) {
        STATE.clips = [];
        STATE.selectedClipId = null;
        selectClip(null);
        updateTimelineClipsUI();
        recalculateTotalDuration();
        renderPreview();
    }
}

// 실제 타임라인 클립들의 총 재생 길이 (초)
function getProjectContentDuration() {
    if (!STATE.clips || STATE.clips.length === 0) return 0;
    let maxEnd = 0;
    STATE.clips.forEach(c => {
        const end = c.timelineStart + c.duration;
        if (end > maxEnd) maxEnd = end;
    });
    return parseFloat(maxEnd.toFixed(2));
}

// 타임라인 총 길이 재계산
function recalculateTotalDuration() {
    const contentDur = getProjectContentDuration();
    STATE.totalDuration = contentDur > 0 ? contentDur : 10.0;
    drawRuler();
    updateTimeDisplay();
}

// 타임라인 줌 변경
function updateTimelineZoom() {
    DOM.zoomValueText.textContent = `${STATE.timelineZoom} px/s`;
    
    const trackWidth = Math.max(1200, STATE.totalDuration * STATE.timelineZoom + 300);
    const lanes = [DOM.trackVideo1, DOM.trackVideo2, DOM.trackAudio, DOM.trackOverlay];
    lanes.forEach(lane => {
        lane.style.width = `${trackWidth}px`;
        lane.style.backgroundSize = `${STATE.timelineZoom}px 100%`;
    });
    
    updateTimelineClipsUI();
    updatePlayheadPosition();
    drawRuler();
}

// 눈금자 그리기
function drawRuler() {
    const canvas = DOM.timelineRuler;
    const container = DOM.timelineScrollContainer;
    
    canvas.width = Math.max(1200, STATE.totalDuration * STATE.timelineZoom + 300);
    canvas.height = 28;
    
    const rCtx = canvas.getContext('2d');
    rCtx.clearRect(0, 0, canvas.width, canvas.height);
    rCtx.fillStyle = '#8e8e93';
    rCtx.font = '9px monospace';
    
    const secStep = STATE.timelineZoom < 10 ? 5 : (STATE.timelineZoom < 25 ? 2 : 1);
    const totalSec = Math.ceil(canvas.width / STATE.timelineZoom);
    
    for (let sec = 0; sec <= totalSec; sec += secStep) {
        const x = sec * STATE.timelineZoom;
        rCtx.beginPath();
        rCtx.moveTo(x, 18);
        rCtx.lineTo(x, 28);
        rCtx.strokeStyle = 'rgba(255,255,255,0.2)';
        rCtx.stroke();
        
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        const timeStr = `${m}:${s.toString().padStart(2, '0')}`;
        rCtx.fillText(timeStr, x + 4, 14);
    }
}

// 눈금자 스크러빙
function scrub(e) {
    const rect = DOM.timelineRuler.getBoundingClientRect();
    const scrollLeft = DOM.timelineScrollContainer.scrollLeft;
    const clickX = e.clientX - rect.left + scrollLeft;
    const time = Math.max(0, clickX / STATE.timelineZoom);
    
    setPlayheadTime(time);
}

function setPlayheadTime(time) {
    STATE.playheadTime = Math.max(0, time);
    updatePlayheadPosition();
    updateTimeDisplay();
    renderPreview();
    syncHiddenPlayersTime();
}

function updatePlayheadPosition() {
    const x = STATE.playheadTime * STATE.timelineZoom;
    DOM.playhead.style.transform = `translateX(${x}px)`;
}

// 클립 드래그 이동
function initClipDrag(e, clip) {
    const startX = e.clientX;
    const startTimelineStart = clip.timelineStart;
    
    function onMouseMove(moveE) {
        const deltaX = moveE.clientX - startX;
        const deltaTime = deltaX / STATE.timelineZoom;
        clip.timelineStart = Math.max(0, parseFloat((startTimelineStart + deltaTime).toFixed(2)));
        
        if (clip.id === STATE.selectedClipId) {
            DOM.propTimelineStart.value = clip.timelineStart;
        }
        
        updateTimelineClipsUIOnlyPosition();
        renderPreview();
    }
    
    function onMouseUp() {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        recalculateTotalDuration();
        updateTimelineClipsUI();
    }
    
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

// 클립 좌/우 트리밍 드래그
function initClipTrim(e, clip, handle) {
    const startX = e.clientX;
    const startTimelineStart = clip.timelineStart;
    const startDuration = clip.duration;
    const startSourceStart = clip.sourceStart;
    const startSourceEnd = clip.sourceEnd;
    const speed = clip.speed || 1.0;
    
    const asset = clip.assetId ? STATE.assets.find(a => a.id === clip.assetId) : null;
    const assetDuration = asset ? asset.duration : 1000.0;

    function onMouseMove(moveE) {
        const deltaX = moveE.clientX - startX;
        const deltaTime = deltaX / STATE.timelineZoom;
        
        if (handle === 'left') {
            const maxDelta = startDuration - 0.2;
            const clampedDelta = Math.max(-startSourceStart / speed, Math.min(maxDelta, deltaTime));
            
            clip.timelineStart = parseFloat((startTimelineStart + clampedDelta).toFixed(2));
            clip.duration = parseFloat((startDuration - clampedDelta).toFixed(2));
            clip.sourceStart = parseFloat((startSourceStart + clampedDelta * speed).toFixed(2));
            
            if (clip.id === STATE.selectedClipId) {
                DOM.propTimelineStart.value = clip.timelineStart;
                DOM.propDuration.value = clip.duration;
                DOM.propSourceStart.value = clip.sourceStart;
            }
        } else {
            const maxDelta = (assetDuration - startSourceEnd) / speed;
            const clampedDelta = Math.max(-startDuration + 0.2, Math.min(maxDelta, deltaTime));
            
            clip.duration = parseFloat((startDuration + clampedDelta).toFixed(2));
            clip.sourceEnd = parseFloat((startSourceEnd + clampedDelta * speed).toFixed(2));
            
            if (clip.id === STATE.selectedClipId) {
                DOM.propDuration.value = clip.duration;
                DOM.propSourceEnd.value = clip.sourceEnd;
            }
        }
        
        updateTimelineClipsUIOnlyPosition();
        renderPreview();
    }
    
    function onMouseUp() {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        recalculateTotalDuration();
        updateTimelineClipsUI();
    }
    
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
}

// --- 재생 제어 엔진 (HTML5 Canvas & Web Audio) ---
function togglePlayback() {
    if (STATE.isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    STATE.isPlaying = true;
    STATE.lastTimeUpdate = performance.now();
    DOM.btnPlay.innerHTML = '<i class="fa-solid fa-pause"></i>';
    DOM.btnPlay.title = '일시정지 (Space)';
    
    updateActivePlayersStates();
    playbackLoop();
}

function stopPlayback() {
    STATE.isPlaying = false;
    if (STATE.lastAnimFrameId) {
        cancelAnimationFrame(STATE.lastAnimFrameId);
        STATE.lastAnimFrameId = null;
    }
    DOM.btnPlay.innerHTML = '<i class="fa-solid fa-play"></i>';
    DOM.btnPlay.title = '재생 (Space)';
    pauseAllPlayers();
}

function stepFrame(seconds) {
    if (STATE.isPlaying) stopPlayback();
    setPlayheadTime(STATE.playheadTime + seconds);
}

function playbackLoop() {
    if (!STATE.isPlaying) return;

    const now = performance.now();
    const dt = (now - STATE.lastTimeUpdate) / 1000;
    STATE.lastTimeUpdate = now;

    let newTime = STATE.playheadTime + dt;
    if (newTime >= STATE.totalDuration) {
        newTime = 0;
        setPlayheadTime(0);
        stopPlayback();
        return;
    }

    STATE.playheadTime = newTime;
    updatePlayheadPosition();
    updateTimeDisplay();
    updateActivePlayersStates();
    renderPreview();

    STATE.lastAnimFrameId = requestAnimationFrame(playbackLoop);
}

function updateActivePlayersStates() {
    const time = STATE.playheadTime;
    const now = performance.now();

    STATE.assets.forEach(asset => {
        const player = activePlayers[asset.id];
        if (!player) return;

        const activeClip = STATE.clips.find(c => c.assetId === asset.id && time >= c.timelineStart && time < c.timelineStart + c.duration);
        
        if (activeClip) {
            const clipElapsed = time - activeClip.timelineStart;
            const speed = activeClip.speed || 1.0;
            const targetTime = activeClip.sourceStart + clipElapsed * speed;

            if (player.paused && player.readyState >= 2) {
                try {
                    player.currentTime = targetTime;
                    player.playbackRate = speed;
                    player.play().catch(e => console.warn("Player play error:", e));
                } catch (e) {}
            } else if (!player.paused) {
                const diff = player.currentTime - targetTime;
                const absDiff = Math.abs(diff);

                if (absDiff > 0.4) {
                    const lastSeek = STATE.playerLastSeekTimes[asset.id] || 0;
                    if (now - lastSeek > 500) {
                        try {
                            player.currentTime = targetTime;
                        } catch (e) {}
                        player.playbackRate = speed;
                        STATE.playerLastSeekTimes[asset.id] = now;
                    }
                } else if (absDiff > 0.08) {
                    player.playbackRate = diff > 0 ? speed * 0.96 : speed * 1.04;
                } else {
                    if (player.playbackRate !== speed) player.playbackRate = speed;
                }
            }
        } else {
            if (!player.paused) {
                player.pause();
                player.playbackRate = 1.0;
            }
        }
    });
}

function pauseAllPlayers() {
    Object.values(activePlayers).forEach(player => {
        if (!player.paused) player.pause();
        player.playbackRate = 1.0;
    });
}

function syncHiddenPlayersTime() {
    const time = STATE.playheadTime;
    STATE.assets.forEach(asset => {
        const player = activePlayers[asset.id];
        if (!player) return;
        
        const activeClip = STATE.clips.find(c => c.assetId === asset.id && time >= c.timelineStart && time < c.timelineStart + c.duration);
        if (activeClip) {
            const clipElapsed = time - activeClip.timelineStart;
            const speed = activeClip.speed || 1.0;
            if (player.readyState >= 1) {
                try {
                    player.currentTime = activeClip.sourceStart + clipElapsed * speed;
                } catch (e) {}
            }
        }
    });
}

function updateActivePlayersVolumes() {
    const time = STATE.playheadTime;
    STATE.assets.forEach(asset => {
        const player = activePlayers[asset.id];
        if (!player) return;

        const activeClip = STATE.clips.find(c => c.assetId === asset.id && time >= c.timelineStart && time < c.timelineStart + c.duration);
        if (activeClip && !STATE.isMuted) {
            const clipVol = activeClip.volume !== undefined ? activeClip.volume : 1.0;
            player.volume = clipVol * STATE.previewVolume;
            player.muted = false;
        } else {
            player.volume = 0;
            player.muted = true;
        }
    });
}

function toggleMute() {
    STATE.isMuted = !STATE.isMuted;
    updateMuteUI();
    updateActivePlayersVolumes();
}

function updateMuteUI() {
    if (STATE.isMuted) {
        DOM.btnMute.className = 'fa-solid fa-volume-xmark mute-icon muted';
        DOM.previewVolumeSlider.value = 0;
    } else {
        DOM.btnMute.className = 'fa-solid fa-volume-high mute-icon';
        DOM.previewVolumeSlider.value = STATE.previewVolume;
    }
}

function updateTimeDisplay() {
    const contentDur = getProjectContentDuration();
    const currentStr = formatHHMMSS(STATE.playheadTime);
    const totalStr = formatHHMMSS(contentDur);
    DOM.timeDisplay.textContent = `${currentStr} / ${totalStr}`;
}

function formatHHMMSS(seconds) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

function formatTimeShort(seconds) {
    if (isNaN(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- 실시간 프리뷰 렌더러 (해상도 가변 Canvas Rendering Engine) ---
function renderPreview() {
    const time = STATE.playheadTime;
    const canvasW = DOM.previewCanvas.width;
    const canvasH = DOM.previewCanvas.height;
    
    // Canvas 초기화
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 1. 비디오 트랙 1 (메인 영상)
    const v1Clip = STATE.clips.find(c => c.track === 'video1' && time >= c.timelineStart && time < c.timelineStart + c.duration);
    if (v1Clip) {
        drawVideoClip(v1Clip, time, 0, 0, canvasW, canvasH);
    }

    // 2. 비디오 트랙 2 (PIP 오버레이 영상)
    const v2Clip = STATE.clips.find(c => c.track === 'video2' && time >= c.timelineStart && time < c.timelineStart + c.duration);
    if (v2Clip) {
        const pip = v2Clip.pip || { width: 320, height: 180, x: 20, y: 20 };
        // 1280x720 기준 좌표계를 현재 캔버스 해상도에 맞추어 스케일링
        const scaleX = canvasW / 1280;
        const scaleY = canvasH / 720;
        const px = pip.x * scaleX;
        const py = pip.y * scaleY;
        const pw = pip.width * scaleX;
        const ph = pip.height * scaleY;
        
        drawVideoClip(v2Clip, time, px, py, pw, ph);
    }

    // 3. PNG 이미지 오버레이 및 자막
    const overlayClips = STATE.clips.filter(c => c.track === 'overlay' && time >= c.timelineStart && time < c.timelineStart + c.duration);
    overlayClips.forEach(clip => {
        if (clip.overlayType === 'image') {
            const asset = STATE.assets.find(a => a.id === clip.assetId);
            if (asset && asset.url) {
                const scaleX = canvasW / 1280;
                const scaleY = canvasH / 720;
                const imgX = (clip.x || 0) * scaleX;
                const imgY = (clip.y || 0) * scaleY;
                const imgW = (clip.width || 150) * scaleX;
                const imgH = (clip.height || 150) * scaleY;
                
                const img = new Image();
                img.src = asset.url;
                if (img.complete) {
                    ctx.drawImage(img, imgX, imgY, imgW, imgH);
                } else {
                    img.onload = () => {
                        if (STATE.playheadTime === time) {
                            ctx.drawImage(img, imgX, imgY, imgW, imgH);
                        }
                    };
                }
            }
        } else if (clip.overlayType === 'text') {
            const scale = canvasW / 1280;
            ctx.fillStyle = clip.textColor || '#ffffff';
            const fontFamily = getCanvasFontFamily(clip.textFont);
            const fontSize = Math.round((clip.textSize || 36) * scale);
            ctx.font = `500 ${fontSize}px ${fontFamily}`;
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 6;
            
            let textX = clip.x === 640 ? canvasW / 2 : (clip.x * (canvasW / 1280));
            let textY = clip.y * (canvasH / 720);
            
            ctx.textAlign = clip.x === 640 ? 'center' : 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(clip.text || '', textX, textY);
            
            ctx.shadowBlur = 0;
        }
    });
}

// 개별 비디오 그리기 + 필터 + 변환 엔진
function drawVideoClip(clip, time, x, y, w, h) {
    const player = activePlayers[clip.assetId];
    if (!player) return;

    const asset = STATE.assets.find(a => a.id === clip.assetId);
    if (asset && asset.isPreviewDisabled) {
        ctx.save();
        const cx = x + w / 2;
        const cy = y + h / 2;
        ctx.translate(cx, cy);
        
        if (clip.rotation !== 0) {
            ctx.rotate((clip.rotation * Math.PI) / 180);
        }

        ctx.fillStyle = '#1e1e24';
        ctx.fillRect(-w / 2, -h / 2, w, h);
        
        ctx.strokeStyle = '#ff1744';
        ctx.lineWidth = 2;
        ctx.strokeRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10);
        
        ctx.fillStyle = '#ff1744';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('브라우저 프리뷰 불가 포맷', 0, -8);
        ctx.fillStyle = '#8e8e93';
        ctx.font = '10px sans-serif';
        ctx.fillText('(로컬 FFmpeg 렌더링은 지원됨)', 0, 8);
        
        ctx.restore();
        return;
    }

    const clipElapsed = time - clip.timelineStart;
    const sourcePlayTime = clip.sourceStart + clipElapsed * (clip.speed || 1.0);
    
    if (!STATE.isPlaying) {
        if (player.readyState >= 1) {
            try {
                if (Math.abs(player.currentTime - sourcePlayTime) > 0.05) {
                    player.currentTime = sourcePlayTime;
                }
            } catch (e) {}
        }
    }

    ctx.save();
    
    // 캔버스 필터 이펙트 구현
    let filterString = '';
    if (clip.effects && clip.effects.length > 0) {
        clip.effects.forEach(eff => {
            if (eff === 'grayscale') filterString += 'grayscale(100%) ';
            else if (eff === 'sepia') filterString += 'sepia(100%) ';
        });
    }
    ctx.filter = filterString.trim() || 'none';

    // 페이드아웃 효과 계산
    if (clip.effects && clip.effects.includes('fade_out')) {
        const fadeDuration = (clip.fadeOutDuration !== undefined && clip.fadeOutDuration > 0) ? clip.fadeOutDuration : 0.5;
        const fadeStartTime = clip.timelineStart + clip.duration - fadeDuration;
        if (time >= fadeStartTime) {
            const progress = Math.max(0, Math.min(1, (time - fadeStartTime) / fadeDuration));
            ctx.globalAlpha = Math.max(0, 1.0 - progress);
        }
    }

    // 회전 렌더링
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.translate(cx, cy);

    if (clip.rotation !== 0) {
        ctx.rotate((clip.rotation * Math.PI) / 180);
    }

    // 줌 효과 계산
    let zoomScale = 1.0;
    if (clip.effects && clip.effects.includes('zoom_in')) zoomScale = 1.5;
    else if (clip.effects && clip.effects.includes('zoom_out')) zoomScale = 0.75;

    const drawW = w * zoomScale;
    const drawH = h * zoomScale;

    try {
        if (player.readyState >= 2) {
            ctx.drawImage(player, -drawW / 2, -drawH / 2, drawW, drawH);
        } else {
            ctx.fillStyle = '#1a1a20';
            ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
        }
    } catch (e) {}

    ctx.restore();
}

function getCanvasFontFamily(fontKey) {
    switch (fontKey) {
        case 'malgun':
            return "'Malgun Gothic', 'Noto Sans KR', sans-serif";
        case 'gulim':
            return "'Gulim', 'GulimChe', sans-serif";
        case 'batang':
            return "'Batang', 'BatangChe', serif";
        case 'arial':
            return "'Arial', sans-serif";
        default:
            return "'Malgun Gothic', 'Noto Sans KR', 'Outfit', sans-serif";
    }
}

// --- 프리뷰 캔버스 상의 자막/오버레이/PIP 마우스 드래그 이동 엔진 ---
let draggedCanvasClip = null;
let dragCanvasOffset = { x: 0, y: 0 };

DOM.previewCanvas.addEventListener('mousedown', (e) => {
    const rect = DOM.previewCanvas.getBoundingClientRect();
    const canvasW = DOM.previewCanvas.width;
    const canvasH = DOM.previewCanvas.height;
    
    // 마우스 클릭 위치를 1280x720 기준 좌표로 변환
    const clickCanvasX = (e.clientX - rect.left) * (canvasW / rect.width);
    const clickCanvasY = (e.clientY - rect.top) * (canvasH / rect.height);
    const logX = clickCanvasX * (1280 / canvasW);
    const logY = clickCanvasY * (720 / canvasH);

    const time = STATE.playheadTime;
    const activeClips = STATE.clips.filter(c => time >= c.timelineStart && time < c.timelineStart + c.duration);
    
    let foundClip = null;
    
    // 1. 자막 및 오버레이 검증 (역순 우선순위)
    const overlayClips = activeClips.filter(c => c.track === 'overlay').reverse();
    for (const clip of overlayClips) {
        if (clip.overlayType === 'text') {
            const tx = clip.x === 640 ? 640 : clip.x;
            const ty = clip.y;
            const tw = Math.max(120, (clip.text || '').length * ((clip.textSize || 36) * 0.7));
            const th = (clip.textSize || 36) * 1.5;
            
            const boxLeft = tx - tw / 2;
            const boxTop = ty - th / 2;
            
            if (logX >= boxLeft && logX <= boxLeft + tw && logY >= boxTop && logY <= boxTop + th) {
                foundClip = clip;
                dragCanvasOffset.x = logX - clip.x;
                dragCanvasOffset.y = logY - clip.y;
                break;
            }
        } else if (clip.overlayType === 'image') {
            const iw = clip.width || 150;
            const ih = clip.height || 150;
            if (logX >= clip.x && logX <= clip.x + iw && logY >= clip.y && logY <= clip.y + ih) {
                foundClip = clip;
                dragCanvasOffset.x = logX - clip.x;
                dragCanvasOffset.y = logY - clip.y;
                break;
            }
        }
    }
    
    // 2. 비디오 트랙 2 (PIP 오버레이) 검증
    if (!foundClip) {
        const pipClips = activeClips.filter(c => c.track === 'video2').reverse();
        for (const clip of pipClips) {
            const pip = clip.pip || { width: 320, height: 180, x: 20, y: 20 };
            if (logX >= pip.x && logX <= pip.x + pip.width && logY >= pip.y && logY <= pip.y + pip.height) {
                foundClip = clip;
                dragCanvasOffset.x = logX - pip.x;
                dragCanvasOffset.y = logY - pip.y;
                break;
            }
        }
    }
    
    if (foundClip) {
        draggedCanvasClip = foundClip;
        selectClip(foundClip.id);
        
        window.addEventListener('mousemove', onCanvasMouseMove);
        window.addEventListener('mouseup', onCanvasMouseUp);
    }
});

function onCanvasMouseMove(e) {
    if (!draggedCanvasClip) return;
    
    const rect = DOM.previewCanvas.getBoundingClientRect();
    const canvasW = DOM.previewCanvas.width;
    const canvasH = DOM.previewCanvas.height;
    
    const clickCanvasX = (e.clientX - rect.left) * (canvasW / rect.width);
    const clickCanvasY = (e.clientY - rect.top) * (canvasH / rect.height);
    const logX = clickCanvasX * (1280 / canvasW);
    const logY = clickCanvasY * (720 / canvasH);
    
    let newX = Math.round(logX - dragCanvasOffset.x);
    let newY = Math.round(logY - dragCanvasOffset.y);
    
    if (draggedCanvasClip.track === 'video2') {
        draggedCanvasClip.pip.x = Math.max(0, Math.min(1280 - (draggedCanvasClip.pip.width || 320), newX));
        draggedCanvasClip.pip.y = Math.max(0, Math.min(720 - (draggedCanvasClip.pip.height || 180), newY));
        DOM.propPipX.value = draggedCanvasClip.pip.x;
        DOM.propPipY.value = draggedCanvasClip.pip.y;
    } else {
        draggedCanvasClip.x = Math.max(0, Math.min(1280, newX));
        draggedCanvasClip.y = Math.max(0, Math.min(720, newY));
        DOM.propTextX.value = draggedCanvasClip.x;
        DOM.propTextY.value = draggedCanvasClip.y;
    }
    
    renderPreview();
}

function onCanvasMouseUp() {
    window.removeEventListener('mousemove', onCanvasMouseMove);
    window.removeEventListener('mouseup', onCanvasMouseUp);
    draggedCanvasClip = null;
}

/* ========================================================================
   원클릭 즉시 렌더링 엔진 (Direct Rendering Engine)
   ======================================================================== */
async function startDirectRendering() {
    // 1. 메인 비디오 트랙 1 검증
    const video1Clips = STATE.clips.filter(c => c.track === 'video1');
    if (video1Clips.length === 0) {
        alert("메인 비디오 트랙(Video Track 1)에 최소 하나 이상의 비디오 클립이 있어야 렌더링할 수 있습니다.");
        return;
    }

    // 2. FFmpeg 커맨드 및 파라미터 생성
    const result = generateFFmpegCommand({
        clips: STATE.clips,
        assets: STATE.assets,
        outputWidth: STATE.outputWidth,
        outputHeight: STATE.outputHeight,
        outputFps: STATE.outputFps,
        encoder: STATE.encoder || 'h264_nvenc'
    });

    if (result.error) {
        alert(`[렌더링 준비 오류]\n\n${result.error}`);
        return;
    }

    STATE.activeRenderOutput = result.outputFile;

    // 3. 모달 열기 및 초기화
    openRenderModal();
    updateRenderModalUI({
        heading: "렌더링 준비 중...",
        desc: "로컬 렌더링 서버 및 FFmpeg 연결을 확인하고 있습니다.",
        progress: 0,
        currentTime: "00:00",
        totalTime: formatTimeShort(STATE.totalDuration),
        status: "preparing"
    });

    // 4. 로컬 서버 연결 확인
    let isServerAvailable = false;
    try {
        const pingRes = await fetch('/api/ping', { method: 'GET', cache: 'no-store' });
        if (pingRes.ok) {
            const pingData = await pingRes.json();
            if (pingData.status === 'ok') {
                isServerAvailable = true;
            }
        }
    } catch (e) {
        isServerAvailable = false;
    }

    if (isServerAvailable) {
        // [모드 1] 로컬 서버를 통한 고속 FFmpeg 즉시 렌더링 실행
        runLocalServerRender(result);
    } else {
        // [모드 2] 브라우저 내장 클라이언트 사이드 즉시 렌더링 실행
        runBrowserClientRender();
    }
}

// [모드 1] 로컬 서버 FFmpeg 렌더링
async function runLocalServerRender(renderParams) {
    try {
        const startRes = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command: renderParams.command,
                outputFile: renderParams.outputFile,
                totalDuration: getProjectContentDuration(),
                fps: STATE.outputFps
            })
        });

        const startData = await startRes.json();
        if (!startRes.ok) {
            throw new Error(startData.error || "렌더링 시작 요청이 거부되었습니다.");
        }

        updateRenderModalUI({
            heading: "고화질 비디오 인코딩 중...",
            desc: "로컬 FFmpeg를 통해 필터 합성 및 렌더링을 진행하고 있습니다.",
            engine: `로컬 FFmpeg (${STATE.encoder === 'h264_nvenc' ? 'GPU: NVENC' : 'CPU: x264'})`,
            status: "rendering"
        });

        // 진행률 폴링 시작 (250ms 주기)
        if (STATE.renderPollingTimer) clearInterval(STATE.renderPollingTimer);
        STATE.renderPollingTimer = setInterval(pollRenderProgress, 250);

    } catch (err) {
        console.error("Local render start error:", err);
        updateRenderModalUI({
            heading: "렌더링 시작 실패",
            desc: err.message,
            status: "error"
        });
    }
}

async function pollRenderProgress() {
    try {
        const res = await fetch('/api/render/progress', { method: 'GET', cache: 'no-store' });
        if (!res.ok) return;

        const data = await res.json();
        
        if (data.status === 'rendering') {
            updateRenderModalUI({
                progress: data.progress || 0,
                currentTime: data.currentTime ? data.currentTime.slice(3, 8) : "00:00",
                totalTime: formatTimeShort(STATE.totalDuration),
                elapsed: data.elapsedTime,
                fpsInfo: `${data.fps || STATE.outputFps} fps (${data.speed || '1.0x'})`,
                status: "rendering"
            });
        } else if (data.status === 'completed') {
            clearInterval(STATE.renderPollingTimer);
            STATE.renderPollingTimer = null;

            updateRenderModalUI({
                progress: 100,
                heading: "렌더링 완료!",
                desc: "성공적으로 고화질 비디오 렌더링이 완료되었습니다.",
                outputFile: data.outputFile || STATE.activeRenderOutput,
                elapsed: data.elapsedTime,
                status: "completed"
            });
        } else if (data.status === 'error') {
            clearInterval(STATE.renderPollingTimer);
            STATE.renderPollingTimer = null;

            updateRenderModalUI({
                heading: "렌더링 중 오류 발생",
                desc: data.error || "FFmpeg 인코딩 중 오류가 발생했습니다.",
                status: "error"
            });
        } else if (data.status === 'cancelled') {
            clearInterval(STATE.renderPollingTimer);
            STATE.renderPollingTimer = null;

            updateRenderModalUI({
                heading: "렌더링 취소됨",
                desc: "사용자에 의해 렌더링이 중단되었습니다.",
                status: "cancelled"
            });
        }
    } catch (e) {
        console.warn("Poll progress error:", e);
    }
}

// 비디오 엘리먼트 비동기 Seek 완료 대기 헬퍼
function waitPlayerSeek(player, targetTime) {
    return new Promise(resolve => {
        if (Math.abs(player.currentTime - targetTime) < 0.02 && player.readyState >= 2) {
            return resolve();
        }
        let timer = null;
        const onSeeked = () => {
            if (timer) clearTimeout(timer);
            player.removeEventListener('seeked', onSeeked);
            resolve();
        };
        timer = setTimeout(() => {
            player.removeEventListener('seeked', onSeeked);
            resolve();
        }, 150); // 150ms 타임아웃 세이프가드
        player.addEventListener('seeked', onSeeked, { once: true });
        try {
            player.currentTime = targetTime;
        } catch (e) {
            resolve();
        }
    });
}

// [모드 2] 브라우저 내장 클라이언트 사이드 즉시 렌더링 (Canvas + MediaRecorder)
async function runBrowserClientRender() {
    const totalDuration = getProjectContentDuration();
    if (totalDuration <= 0) {
        alert("타임라인에 렌더링할 클립이 없습니다.");
        DOM.renderModal.classList.remove('show');
        return;
    }

    updateRenderModalUI({
        heading: "브라우저 즉시 렌더링 중...",
        desc: "브라우저 내장 인코더를 통해 타임라인을 합성하고 있습니다.",
        engine: "브라우저 Canvas MediaRecorder",
        status: "rendering"
    });

    try {
        const renderCanvas = document.createElement('canvas');
        renderCanvas.width = STATE.outputWidth;
        renderCanvas.height = STATE.outputHeight;
        const rCtx = renderCanvas.getContext('2d');

        const fps = STATE.outputFps || 30;
        const stream = renderCanvas.captureStream(fps);
        
        let mimeType = 'video/webm; codecs=vp9';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'video/webm';
        }

        const recorder = new MediaRecorder(stream, {
            mimeType: mimeType,
            videoBitsPerSecond: 10000000
        });

        const chunks = [];
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        const renderPromise = new Promise(resolve => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: 'video/webm' });
                const url = URL.createObjectURL(blob);
                const fileName = `LookVideo_${formatDateForFilename(new Date())}.webm`;

                // 자동 다운로드 트리거
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                updateRenderModalUI({
                    progress: 100,
                    heading: "브라우저 렌더링 완료!",
                    desc: "영상이 생성되어 다운로드 폴더에 자동 저장되었습니다.",
                    outputFile: fileName,
                    status: "completed",
                    isBrowserBlob: true,
                    blobUrl: url
                });
                resolve();
            };
        });

        recorder.start();

        const totalFrames = Math.ceil(totalDuration * fps);
        const frameInterval = 1 / fps;
        const startTime = Date.now();

        for (let i = 0; i <= totalFrames; i++) {
            if (!DOM.renderModal.classList.contains('show')) {
                recorder.stop();
                return;
            }

            const currentTime = Math.min(totalDuration, i * frameInterval);

            // 해당 시점의 활성 비디오 클립 플레이어들을 Seek 대기
            const activeVideoClips = STATE.clips.filter(c => 
                (c.track === 'video1' || c.track === 'video2') && 
                currentTime >= c.timelineStart && 
                currentTime < c.timelineStart + c.duration
            );

            for (const clip of activeVideoClips) {
                const player = activePlayers[clip.assetId];
                if (player) {
                    const clipElapsed = currentTime - clip.timelineStart;
                    const speed = clip.speed || 1.0;
                    const sourcePlayTime = clip.sourceStart + clipElapsed * speed;
                    await waitPlayerSeek(player, sourcePlayTime);
                }
            }

            // 시점 설정 및 프레임 그리기
            setPlayheadTime(currentTime);
            renderPreview();
            rCtx.drawImage(DOM.previewCanvas, 0, 0, renderCanvas.width, renderCanvas.height);

            const progress = Math.min(99, Math.round((i / totalFrames) * 100));
            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const m = Math.floor(elapsedSec / 60);
            const s = elapsedSec % 60;

            updateRenderModalUI({
                progress: progress,
                currentTime: formatTimeShort(currentTime),
                totalTime: formatTimeShort(totalDuration),
                elapsed: `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`,
                fpsInfo: `${fps} fps`,
                status: "rendering"
            });

            // MediaRecorder 프레임 캡처 대기
            await new Promise(r => setTimeout(r, 20));
        }

        await new Promise(r => setTimeout(r, 200));
        recorder.stop();
        await renderPromise;

    } catch (err) {
        console.error("Browser client render error:", err);
        updateRenderModalUI({
            heading: "렌더링 실패",
            desc: err.message,
            status: "error"
        });
    }
}

// 렌더링 모달 UI 갱신 헬퍼
function updateRenderModalUI(data) {
    if (data.heading) DOM.renderStatusHeading.textContent = data.heading;
    if (data.desc) DOM.renderStatusDesc.textContent = data.desc;
    
    if (data.progress !== undefined) {
        const pct = Math.round(data.progress);
        DOM.renderProgressBar.style.width = `${pct}%`;
        DOM.renderProgressPercent.textContent = `${pct}%`;
    }
    
    if (data.currentTime && data.totalTime) {
        DOM.renderProgressDetails.textContent = `${data.currentTime} / ${data.totalTime}`;
    }
    
    if (data.engine) DOM.renderMetaEngine.textContent = data.engine;
    if (data.elapsed) DOM.renderMetaTime.textContent = data.elapsed;
    if (data.fpsInfo) DOM.renderMetaFps.textContent = data.fpsInfo;

    DOM.renderMetaRes.textContent = `${STATE.outputWidth} x ${STATE.outputHeight}`;

    if (data.status === 'completed') {
        DOM.renderSpinner.classList.add('hide');
        DOM.renderCompleteActions.classList.remove('hide');
        DOM.renderOutputFilename.textContent = data.outputFile || STATE.activeRenderOutput;
        
        DOM.btnCancelRender.classList.add('hide');
        DOM.btnRenderDone.classList.remove('hide');
        
        if (data.isBrowserBlob) {
            DOM.btnDownloadRenderedVideo.classList.remove('hide');
            DOM.btnDownloadRenderedVideo.onclick = () => {
                const a = document.createElement('a');
                a.href = data.blobUrl;
                a.download = data.outputFile;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            };
        } else {
            DOM.btnOpenRenderedFile.classList.remove('hide');
            DOM.btnOpenOutputFolder.classList.remove('hide');
        }
    } else if (data.status === 'error' || data.status === 'cancelled') {
        DOM.renderSpinner.classList.add('hide');
        DOM.btnCancelRender.classList.add('hide');
        DOM.btnRenderDone.classList.remove('hide');
    }
}

function openRenderModal() {
    DOM.renderModal.classList.remove('hide');
    DOM.renderModal.classList.add('show');
    
    DOM.renderSpinner.classList.remove('hide');
    DOM.renderCompleteActions.classList.add('hide');
    DOM.btnCancelRender.classList.remove('hide');
    DOM.btnOpenRenderedFile.classList.add('hide');
    DOM.btnOpenOutputFolder.classList.add('hide');
    DOM.btnDownloadRenderedVideo.classList.add('hide');
    DOM.btnRenderDone.classList.add('hide');
}

function closeRenderModal() {
    DOM.renderModal.classList.remove('show');
    setTimeout(() => DOM.renderModal.classList.add('hide'), 250);
}

async function cancelRendering() {
    if (confirm("진행 중인 렌더링 작업을 취소하시겠습니까?")) {
        if (STATE.renderPollingTimer) {
            clearInterval(STATE.renderPollingTimer);
            STATE.renderPollingTimer = null;
        }
        try {
            await fetch('/api/render/cancel', { method: 'POST' });
        } catch (e) {}

        updateRenderModalUI({
            heading: "렌더링이 취소되었습니다",
            desc: "작업이 중단되었습니다.",
            status: "cancelled"
        });
    }
}

async function openRenderedVideoFile() {
    try {
        await fetch('/api/open-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outputFile: STATE.activeRenderOutput })
        });
    } catch (e) {
        console.error("Open file error:", e);
    }
}

async function openOutputFolder() {
    try {
        await fetch('/api/open-output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outputFile: STATE.activeRenderOutput })
        });
    } catch (e) {
        console.error("Open output folder error:", e);
    }
}

// --- 프로젝트 제어 파일 입출력 (Save/Load) ---
function confirmNewProject() {
    if (confirm("프로젝트를 초기화하고 모든 타임라인 설정을 삭제하시겠습니까?")) {
        STATE.assets = [];
        STATE.clips = [];
        STATE.selectedClipId = null;
        STATE.playheadTime = 0;
        
        DOM.hiddenPlayersContainer.innerHTML = '';
        Object.keys(activePlayers).forEach(k => delete activePlayers[k]);
        
        STATE.outputWidth = 1920;
        STATE.outputHeight = 1080;
        STATE.outputFps = 30;
        if (DOM.projectResolution) DOM.projectResolution.value = "1920x1080";
        if (DOM.projectFps) DOM.projectFps.value = "30";
        
        updatePreviewResolution();
        selectClip(null);
        updateAssetListUI();
        updateTimelineClipsUI();
        recalculateTotalDuration();
        renderPreview();
    }
}

function saveProjectFile() {
    const cleanAssets = STATE.assets.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        duration: a.duration,
        localPath: a.localPath
    }));

    const projectData = {
        version: "LookVideoEditor-v2.0",
        assets: cleanAssets,
        clips: STATE.clips,
        totalDuration: STATE.totalDuration,
        outputWidth: STATE.outputWidth,
        outputHeight: STATE.outputHeight,
        outputFps: STATE.outputFps,
        encoder: STATE.encoder
    };

    const blob = new Blob([JSON.stringify(projectData, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `LookVideoEditor_project_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function loadProjectFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);
            // sVidEditor-v1.0 및 LookVideoEditor 호환
            if (data.version !== "LookVideoEditor-v2.0" && data.version !== "sVidEditor-v1.0") {
                alert("지원하지 않는 프로젝트 규격 파일입니다.");
                return;
            }

            STATE.clips = data.clips.map(c => ({
                ...c,
                speed: c.speed || 1.0
            }));
            STATE.totalDuration = data.totalDuration || 30;
            STATE.outputWidth = data.outputWidth || 1920;
            STATE.outputHeight = data.outputHeight || 1080;
            STATE.outputFps = data.outputFps || 30;
            STATE.encoder = data.encoder || 'h264_nvenc';

            if (DOM.projectResolution) {
                DOM.projectResolution.value = `${STATE.outputWidth}x${STATE.outputHeight}`;
            }
            if (DOM.projectFps) {
                DOM.projectFps.value = STATE.outputFps;
            }
            if (DOM.projectEncoder) {
                DOM.projectEncoder.value = STATE.encoder;
            }
            
            STATE.assets = data.assets.map(a => ({
                ...a,
                url: null,
                file: null
            }));
            
            updatePreviewResolution();
            STATE.selectedClipId = null;
            selectClip(null);
            updateAssetListUI();
            updateTimelineClipsUI();
            recalculateTotalDuration();
            renderPreview();

            showMediaReconnectModal();
            
        } catch (err) {
            console.error("JSON 파싱 에러:", err);
            alert("프로젝트 파일을 읽는 도중 오류가 발생했습니다.");
        }
    };
    reader.readAsText(file);
}

function showMediaReconnectModal() {
    const existing = document.getElementById('media-reconnect-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'media-reconnect-modal';
    overlay.className = 'modal-overlay';
    
    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <i class="fa-solid fa-clapperboard"></i>
                <h3>프로젝트 불러오기 완료</h3>
            </div>
            <div class="modal-body">
                <p>프로젝트 설정을 성공적으로 불러왔습니다!</p>
                <p style="margin-top: 8px;">브라우저의 보안 제한으로 인해 비디오/오디오 미리보기를 활성화하려면, <strong>프로젝트에 사용된 미디어 파일들을 다시 한 번 선택</strong>해 주셔야 합니다.</p>
                <div class="highlight-group" style="margin-top: 12px;">
                    <i class="fa-solid fa-circle-info"></i> 로컬 FFmpeg 렌더링 경로와 편집했던 타임라인 클립 정보는 그대로 유지됩니다.
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-btn-cancel" class="btn btn-secondary">나중에</button>
                <button id="modal-btn-select" class="btn btn-primary"><i class="fa-solid fa-file-video"></i> 미디어 파일 선택</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
        overlay.classList.add('show');
    });

    const selectBtn = overlay.querySelector('#modal-btn-select');
    const cancelBtn = overlay.querySelector('#modal-btn-cancel');

    selectBtn.addEventListener('click', () => {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 250);
        DOM.inputMedia.click();
    });

    cancelBtn.addEventListener('click', () => {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 250);
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.classList.remove('show');
            setTimeout(() => overlay.remove(), 250);
        }
    });
}

/* ========================================================================
   패널 크기 조절 (Resizable Panels)
   ======================================================================== */
function initResizablePanels() {
    const DEFAULTS = {
        'left-center':  { defaultSize: 300, min: 180, max: 600 },
        'center-right': { defaultSize: 340, min: 220, max: 600 },
        'main-timeline':{ defaultSize: 280, min: 150, max: 600 }
    };

    const handles = document.querySelectorAll('.resize-handle');
    let activeHandle = null;
    let startX = 0;
    let startY = 0;
    let startSize = 0;
    let targetElement = null;

    handles.forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();

            activeHandle = handle;
            const handleId = handle.dataset.handle;

            if (handleId === 'left-center') {
                targetElement = document.getElementById('panel-media');
                startX = e.clientX;
                startSize = targetElement.offsetWidth;
                document.body.classList.add('resizing');
            } else if (handleId === 'center-right') {
                targetElement = document.getElementById('panel-properties');
                startX = e.clientX;
                startSize = targetElement.offsetWidth;
                document.body.classList.add('resizing');
            } else if (handleId === 'main-timeline') {
                targetElement = document.querySelector('.app-timeline');
                startY = e.clientY;
                startSize = targetElement.offsetHeight;
                document.body.classList.add('resizing-row');
            }

            handle.classList.add('active');
            document.addEventListener('mousemove', onResizeMove);
            document.addEventListener('mouseup', onResizeEnd);
        });

        handle.addEventListener('dblclick', () => {
            const handleId = handle.dataset.handle;
            const config = DEFAULTS[handleId];
            let el;

            if (handleId === 'left-center') {
                el = document.getElementById('panel-media');
            } else if (handleId === 'center-right') {
                el = document.getElementById('panel-properties');
            } else if (handleId === 'main-timeline') {
                el = document.querySelector('.app-timeline');
            }

            if (el) {
                el.style.flex = `0 0 ${config.defaultSize}px`;
                drawRuler();
            }
        });
    });

    function onResizeMove(e) {
        if (!activeHandle || !targetElement) return;

        const handleId = activeHandle.dataset.handle;
        const config = DEFAULTS[handleId];
        let newSize;

        if (handleId === 'left-center') {
            newSize = startSize + (e.clientX - startX);
        } else if (handleId === 'center-right') {
            newSize = startSize - (e.clientX - startX);
        } else if (handleId === 'main-timeline') {
            newSize = startSize + (startY - e.clientY);
        }

        const clamped = Math.max(config.min, Math.min(config.max, newSize));
        targetElement.style.flex = `0 0 ${clamped}px`;
    }

    function onResizeEnd() {
        if (activeHandle) {
            activeHandle.classList.remove('active');
        }

        activeHandle = null;
        targetElement = null;

        document.body.classList.remove('resizing');
        document.body.classList.remove('resizing-row');

        document.removeEventListener('mousemove', onResizeMove);
        document.removeEventListener('mouseup', onResizeEnd);

        drawRuler();
    }
}
