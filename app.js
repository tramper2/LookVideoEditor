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

    // 애니메이션 WebP 내보내기 설정
    webpRange: { start: 0, duration: 5 },  // 내보낼 타임라인 구간 (초). 최대 WEBP_MAX_DURATION
    webpTargetMB: 3,                       // 결과물이 넘지 않아야 할 최대 용량 (MB)
    webpFps: 20,                           // WebP 프레임 레이트
    isWebpEditMode: false,                 // 타임라인 WebP 구간 편집 모드 활성화 여부

    // GIF 동시 저장 (같은 컷을 .gif 로도 저장 — 29CM·네이버·카페24용)
    gifEnabled: true,                      // 체크박스 기본 켜짐
    gifTargetMB: 5,                        // GIF 목표 용량 (MB)
    gifDuration: 0,                        // GIF 재생 길이(초). 0 = 선택 구간 전체 (줄이면 같은 용량에서 화질↑)
    webpConfirmTarget: 'webp',             // 확인창이 어느 포맷에 대한 것인지
    activeRenderGif: null,                 // 마지막 GIF 결과 경로

    playerLastSeekTimes: {}, // 플레이어별 마지막 Seek 타임스탬프 (ms, 싱크 지터 방지)

    // 렌더링 상태
    isRendering: false,
    renderPollingTimer: null,
    activeRenderOutput: null
};

// WebP 구간 최대 길이(초). 애니메이션 WebP 용량을 감당할 수 있는 상한이다.
const WEBP_MAX_DURATION = 5;
const WEBP_MIN_DURATION = 0.5;

// GIF 재생 길이 선택지(초). 0 은 '선택 구간 전체' — index.html 의 옵션 값과 같아야 한다.
const GIF_DURATION_CHOICES = [3, 2, 1.5, 1];

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
    btnAddBgmSticker: document.getElementById('btn-add-bgm-sticker'),
    assetList: document.getElementById('asset-list'),
    
    previewCanvas: document.getElementById('preview-canvas'),
    previewCanvasWrapper: document.getElementById('preview-canvas-wrapper'),
    previewZoomBadge: document.getElementById('preview-zoom-badge'),
    previewZoomText: document.getElementById('preview-zoom-text'),
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
    propAudioLoop: document.getElementById('prop-audio-loop'),
    propTextContent: document.getElementById('prop-text-content'),
    propTextSize: document.getElementById('prop-text-size'),
    propTextColor: document.getElementById('prop-text-color'),
    propTextOpacity: document.getElementById('prop-text-opacity'),
    propTextOpacityLabel: document.getElementById('prop-text-opacity-label'),
    propTextWeight: document.getElementById('prop-text-weight'),
    propTextEffect: document.getElementById('prop-text-effect'),
    propTextBgbox: document.getElementById('prop-text-bgbox'),
    propTextFont: document.getElementById('prop-text-font'),
    propTextFontCustomGroup: document.getElementById('prop-text-font-custom-group'),
    propTextFontCustom: document.getElementById('prop-text-font-custom'),
    propImgWidth: document.getElementById('prop-img-width'),
    propImgHeight: document.getElementById('prop-img-height'),
    propTextX: document.getElementById('prop-text-x'),
    propTextY: document.getElementById('prop-text-y'),
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

    // 무료 음악 검색 모달 요소
    btnSearchMusic: document.getElementById('btn-search-music'),
    musicSearchModal: document.getElementById('music-search-modal'),
    musicSearchInput: document.getElementById('music-search-input'),
    btnMusicSearchRun: document.getElementById('btn-music-search-run'),
    btnCloseMusicModal: document.getElementById('btn-close-music-modal'),
    btnCloseMusicModalFooter: document.getElementById('btn-close-music-modal-footer'),
    musicTranslateHint: document.getElementById('music-translate-hint'),
    musicKeywordChips: document.getElementById('music-keyword-chips'),
    musicFilterDuration: document.getElementById('music-filter-duration'),
    musicLoopIfShort: document.getElementById('music-loop-if-short'),
    musicResultCount: document.getElementById('music-result-count'),
    musicResultList: document.getElementById('music-result-list'),
    musicStatus: document.getElementById('music-status'),
    musicServerWarning: document.getElementById('music-server-warning'),
    btnOpenRenderedFile: document.getElementById('btn-open-rendered-file'),
    btnOpenOutputFolder: document.getElementById('btn-open-output-folder'),
    btnDownloadRenderedVideo: document.getElementById('btn-download-rendered-video'),
    btnRenderDone: document.getElementById('btn-render-done'),

    // 렌더 모달 - WebP 전용 요소
    renderedResultImage: document.getElementById('rendered-result-image'),
    webpResultSummary: document.getElementById('webp-result-summary'),
    webpConfirmBox: document.getElementById('webp-confirm-box'),
    webpConfirmTitle: document.getElementById('webp-confirm-title'),
    webpConfirmDesc: document.getElementById('webp-confirm-desc'),
    webpConfirmDownscale: document.getElementById('webp-confirm-downscale'),
    webpConfirmFloor: document.getElementById('webp-confirm-floor'),
    webpConfirmCancel: document.getElementById('webp-confirm-cancel'),
    webpGifEnabled: document.getElementById('webp-gif-enabled'),
    webpGifTargetSize: document.getElementById('webp-gif-target-size'),
    webpGifTargetValue: document.getElementById('webp-gif-target-value'),
    webpGifOptions: document.getElementById('webp-gif-options'),
    webpGifDuration: document.getElementById('webp-gif-duration'),
    webpGifDurationValue: document.getElementById('webp-gif-duration-value'),
    btnDownloadRenderedGif: document.getElementById('btn-download-rendered-gif'),
    webpNoteGif: document.getElementById('webp-note-gif'),

    // WebP 내보내기 설정 모달 및 편집 제어
    btnExportWebp: document.getElementById('btn-export-webp'),
    btnToggleWebpHeader: document.getElementById('btn-toggle-webp-header'),
    btnToggleWebpMode: document.getElementById('btn-toggle-webp-mode'),
    btnWebpModalEditRange: document.getElementById('btn-webp-modal-edit-range'),
    webpTimelineBadge: document.getElementById('webp-timeline-badge'),
    webpTimelineRangeText: document.getElementById('webp-timeline-range-text'),
    btnWebpQuickExport: document.getElementById('btn-webp-quick-export'),
    btnWebpQuickClose: document.getElementById('btn-webp-quick-close'),
    webpModal: document.getElementById('webp-modal'),
    webpModalCloseBtn: document.getElementById('webp-modal-close-btn'),
    webpModalCancel: document.getElementById('webp-modal-cancel'),
    btnStartWebp: document.getElementById('btn-start-webp'),
    webpRangeReadout: document.getElementById('webp-range-readout'),
    webpRangeDuration: document.getElementById('webp-range-duration'),
    webpTargetSize: document.getElementById('webp-target-size'),
    webpTargetValue: document.getElementById('webp-target-value'),
    webpFps: document.getElementById('webp-fps'),

    // 타임라인 WebP 구간 밴드
    webpRangeBand: document.getElementById('webp-range-band'),
    webpRangeLabel: document.getElementById('webp-range-label'),
    webpRangeLabelText: document.getElementById('webp-range-label-text'),
    webpRangeCloseBtn: document.getElementById('webp-range-close-btn'),

    // 외부 영상 불러오기 관련 요소
    btnOpenExternalVideo: document.getElementById('btn-open-external-video'),
    externalVideoMenu: document.getElementById('external-video-menu'),
    btnExtSelectFiles: document.getElementById('btn-ext-select-files'),
    btnExtSelectFolder: document.getElementById('btn-ext-select-folder'),
    btnExtInputPath: document.getElementById('btn-ext-input-path'),
    inputExternalVideoFiles: document.getElementById('input-external-video-files'),
    pathInputModal: document.getElementById('path-input-modal'),
    inputFolderPath: document.getElementById('input-folder-path'),
    btnClosePathModal: document.getElementById('btn-close-path-modal'),
    btnCancelPathModal: document.getElementById('btn-cancel-path-modal'),
    btnConfirmPathModal: document.getElementById('btn-confirm-path-modal'),

    // 사진 추출 및 셔터 관련 요소
    btnPlayerCapture: document.getElementById('btn-player-capture'),
    btnTimelineCapture: document.getElementById('btn-timeline-capture'),
    shutterFlash: document.getElementById('shutter-flash'),
    photoExtractToast: document.getElementById('photo-extract-toast'),
    toastPhotoImg: document.getElementById('toast-photo-img'),
    toastPhotoFilename: document.getElementById('toast-photo-filename'),
    toastPhotoFolder: document.getElementById('toast-photo-folder'),
    btnToastOpenFolder: document.getElementById('btn-toast-open-folder'),
    btnToastClose: document.getElementById('btn-toast-close')
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

    // 2-1. 릴스 불러오기 (vTonSales 릴스 저장 폴더 연동)
    initReelsLoader();

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

    // 캔버스 크기가 바뀌면 팬 한계도 다시 계산해야 한다
    applyPreviewTransform();

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
    // 미디어 가져오기 이벤트 (영상은 릴스 폴더 선택으로 로드, 이미지/음악만 파일 선택)
    if (DOM.btnAddBgmSticker) {
        DOM.btnAddBgmSticker.addEventListener('click', () => DOM.inputMedia.click());
    }
    DOM.inputMedia.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleMediaImport(e.target.files);
            e.target.value = '';
        }
    });

    // 탐색기에서 파일을 왼쪽 미디어 목록에 바로 떨어뜨려도 가져온다 (배치는 하지 않고 목록에만 추가)
    if (DOM.assetList) {
        DOM.assetList.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            DOM.assetList.classList.add('dragover-lane');
        });
        DOM.assetList.addEventListener('dragleave', () => {
            DOM.assetList.classList.remove('dragover-lane');
        });
        DOM.assetList.addEventListener('drop', (e) => {
            DOM.assetList.classList.remove('dragover-lane');
            e.preventDefault();
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                handleMediaImport(files);
            }
        });
    }

    // 목표 지점 밖에 파일을 떨어뜨리면 브라우저가 그 파일을 열어버려 편집 내용이 날아간다. 기본 동작을 막는다.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // 무료 음악 검색 (온라인 CC0/퍼블릭 도메인)
    if (DOM.btnSearchMusic) DOM.btnSearchMusic.addEventListener('click', openMusicSearchModal);
    if (DOM.btnMusicSearchRun) DOM.btnMusicSearchRun.addEventListener('click', runMusicSearch);
    if (DOM.musicSearchInput) {
        DOM.musicSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); runMusicSearch(); }
        });
    }
    [DOM.btnCloseMusicModal, DOM.btnCloseMusicModalFooter].forEach(btn => {
        if (btn) btn.addEventListener('click', closeMusicSearchModal);
    });
    if (DOM.musicSearchModal) {
        DOM.musicSearchModal.addEventListener('click', (e) => {
            if (e.target === DOM.musicSearchModal) closeMusicSearchModal();
        });
    }
    if (DOM.musicFilterDuration) {
        DOM.musicFilterDuration.addEventListener('change', () => {
            if (musicState.lastQuery) runMusicSearch();
        });
    }

    // 오디오 클립 반복 재생 토글
    //  updateSelectedClipFromInputs 에 태우지 않는다 — 그쪽 else 분기가 clip.duration 을
    //  입력값으로 덮어써서 루프용 길이 확장이 취소되기 때문이다.
    if (DOM.propAudioLoop) {
        DOM.propAudioLoop.addEventListener('change', () => {
            const clip = STATE.clips.find(c => c.id === STATE.selectedClipId);
            if (!clip || clip.track !== 'audio') return;
            setClipLoop(clip, DOM.propAudioLoop.checked);
            updateTimelineClipsUI();
            recalculateTotalDuration();
            renderPreview();
        });
    }

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

    // WebP 내보내기 설정 모달
    if (DOM.btnExportWebp) DOM.btnExportWebp.addEventListener('click', openWebpModal);
    if (DOM.webpModalCloseBtn) DOM.webpModalCloseBtn.addEventListener('click', closeWebpModal);
    if (DOM.webpModalCancel) DOM.webpModalCancel.addEventListener('click', closeWebpModal);
    if (DOM.btnStartWebp) DOM.btnStartWebp.addEventListener('click', startWebpExportFromModal);
    if (DOM.webpTargetSize) {
        DOM.webpTargetSize.addEventListener('input', (e) => {
            STATE.webpTargetMB = parseFloat(e.target.value);
            DOM.webpTargetValue.textContent = `${STATE.webpTargetMB.toFixed(1)} MB`;
        });
    }
    if (DOM.webpFps) {
        DOM.webpFps.addEventListener('change', (e) => {
            STATE.webpFps = parseInt(e.target.value, 10) || 20;
            updateWebpModalReadout();
        });
    }

    // GIF 동시 저장 (체크박스 + 목표 용량)
    if (DOM.webpGifEnabled) {
        DOM.webpGifEnabled.addEventListener('change', (e) => {
            STATE.gifEnabled = !!e.target.checked;
            updateGifOptionsUI();
        });
    }
    if (DOM.webpGifTargetSize) {
        DOM.webpGifTargetSize.addEventListener('input', (e) => {
            STATE.gifTargetMB = parseFloat(e.target.value) || 5;
            if (DOM.webpGifTargetValue) DOM.webpGifTargetValue.textContent = `${STATE.gifTargetMB.toFixed(1)} MB`;
        });
    }
    if (DOM.webpGifDuration) {
        DOM.webpGifDuration.addEventListener('change', (e) => {
            STATE.gifDuration = Math.max(0, parseFloat(e.target.value) || 0);
        });
    }

    // 해상도 하향 확인 다이얼로그
    if (DOM.webpConfirmDownscale) DOM.webpConfirmDownscale.addEventListener('click', () => confirmWebpDownscale(true));
    if (DOM.webpConfirmFloor) DOM.webpConfirmFloor.addEventListener('click', () => confirmWebpDownscale(false));
    if (DOM.webpConfirmCancel) DOM.webpConfirmCancel.addEventListener('click', cancelRendering);

    // WebP 편집 모드 토글 이벤트
    if (DOM.btnToggleWebpMode) DOM.btnToggleWebpMode.addEventListener('click', () => toggleWebpEditMode());
    if (DOM.btnToggleWebpHeader) DOM.btnToggleWebpHeader.addEventListener('click', () => toggleWebpEditMode());
    if (DOM.btnWebpQuickClose) DOM.btnWebpQuickClose.addEventListener('click', () => toggleWebpEditMode(false));
    if (DOM.btnWebpQuickExport) DOM.btnWebpQuickExport.addEventListener('click', openWebpModal);
    if (DOM.btnWebpModalEditRange) {
        DOM.btnWebpModalEditRange.addEventListener('click', () => {
            closeWebpModal();
            toggleWebpEditMode(true);
        });
    }
    if (DOM.webpRangeCloseBtn) {
        DOM.webpRangeCloseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleWebpEditMode(false);
        });
    }

    // 타임라인 WebP 구간 밴드 드래그
    if (DOM.webpRangeBand) {
        DOM.webpRangeBand.querySelector('.webp-range-handle-left')
            ?.addEventListener('mousedown', (e) => initWebpBandDrag(e, 'left'));
        DOM.webpRangeBand.querySelector('.webp-range-handle-right')
            ?.addEventListener('mousedown', (e) => initWebpBandDrag(e, 'right'));
        DOM.webpRangeBand.addEventListener('mousedown', (e) => {
            // 핸들이나 닫기 버튼이 아닌 몸통을 잡으면 구간 전체 이동
            if (e.target.classList.contains('webp-range-handle') || e.target.closest('#webp-range-close-btn')) return;
            initWebpBandDrag(e, 'move');
        });
    }

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
        DOM.propTextOpacity, DOM.propTextEffect, DOM.propTextBgbox, DOM.propTextWeight,
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

        // 마지막 사용한 폰트 복원하여 기본 셀렉트에 반영
        try {
            const savedFont = localStorage.getItem('look_last_text_font');
            if (savedFont) {
                DOM.propTextFont.value = savedFont;
                if (savedFont === 'custom' && DOM.propTextFontCustomGroup) {
                    DOM.propTextFontCustomGroup.classList.remove('hide');
                    const savedCustom = localStorage.getItem('look_last_text_font_custom');
                    if (savedCustom && DOM.propTextFontCustom) {
                        DOM.propTextFontCustom.value = savedCustom;
                    }
                }
            }
        } catch (e) {}
    }

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
            e.dataTransfer.dropEffect = 'copy';
            lane.classList.add('dragover-lane');
        });
        lane.addEventListener('dragleave', () => {
            lane.classList.remove('dragover-lane');
        });
        lane.addEventListener('drop', (e) => {
            lane.classList.remove('dragover-lane');
            e.preventDefault();

            const targetTrack = lane.parentElement.dataset.trackType;
            const rect = lane.getBoundingClientRect();
            const dropX = e.clientX - rect.left + lane.scrollLeft;
            const dropTime = Math.max(0, dropX / STATE.timelineZoom);

            // 1) 탐색기(OS)에서 파일을 직접 떨어뜨린 경우 → 가져오기 + 그 자리에 배치
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                // 여러 개를 한꺼번에 떨어뜨리면 앞 클립 끝에 차례로 이어 붙인다
                let cursor = dropTime;
                handleMediaImport(files, (asset) => {
                    const before = STATE.clips.length;
                    addAssetToTimeline(asset.id, targetTrack, cursor);
                    if (STATE.clips.length > before) {
                        // addAssetToTimeline 은 동기이므로 방금 놓인 클립이 마지막 항목이다
                        const placed = STATE.clips[STATE.clips.length - 1];
                        cursor = placed.timelineStart + placed.duration;
                    }
                });
                return;
            }

            // 2) 앱 안 미디어 목록에서 끌어온 경우 → 그 자리에 배치
            const assetId = e.dataTransfer.getData('text/plain');
            if (assetId) {
                addAssetToTimeline(assetId, targetTrack, dropTime);
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
// onAssetReady(asset) 는 에셋을 타임라인에 놓을 수 있게 된 시점에 호출된다.
//  - 이미지 : 즉시
//  - 영상/오디오 : 메타데이터가 로드되어 asset.duration 이 확정된 뒤
//    (그 전에 놓으면 길이가 기본값 5초로 굳어버린다)
function handleMediaImport(files, onAssetReady) {
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
                   fileNameLower.endsWith('.jpeg') ||
                   fileNameLower.endsWith('.webp') ||
                   fileNameLower.endsWith('.gif') ||
                   fileNameLower.endsWith('.bmp')) {
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
                // 이미지는 고유 길이가 없으므로 "늘릴 수 있는 상한"을 크게 잡아둔다.
                // duration 은 트림/길이 입력의 상한(assetDuration)으로 쓰이므로,
                // 이 값이 작으면 Video Track 1 의 정지 구간을 늘릴 수 없다.
                duration: type === 'image' ? 60.0 : 5.0,
                url,
                file,
                localPath
            };
            STATE.assets.push(asset);
            uploadAssetFileToServer(asset);
        } else {
            asset.url = url;
            asset.file = file;
            uploadAssetFileToServer(asset);
        }

        // 영상은 onloadedmetadata 뒤에 onerror 까지 겹쳐 발화할 수 있어 한 번만 알린다
        // (두 번 알리면 같은 파일이 타임라인에 클립 두 개로 놓인다)
        let notified = false;
        const notifyReady = () => {
            if (notified) return;
            notified = true;
            if (onAssetReady) onAssetReady(asset);
        };

        // 숨김 플레이어 생성하여 메타데이터 및 프레임 버퍼 로드
        if (type === 'video') {
            const video = document.createElement('video');
            video.src = url;
            video.preload = 'auto';
            video.muted = true;
            video.playsInline = true;
            video.crossOrigin = 'anonymous';
            
            video.onloadedmetadata = () => {
                asset.duration = video.duration || 10.0;
                clearTimeout(safetyTimeout);
                DOM.previewOverlay.classList.add('hide');
                updateAssetListUI();
                updateTimelineClipsUI();
                renderPreview();
                notifyReady();
            };
            video.onerror = () => {
                console.warn("[LookVideoEditor] 비디오 프리뷰 포맷 미지원:", file.name);
                asset.isPreviewDisabled = true;
                clearTimeout(safetyTimeout);
                DOM.previewOverlay.classList.add('hide');
                updateAssetListUI();
                notifyReady();
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
                notifyReady();
            };
            audio.onerror = () => {
                clearTimeout(safetyTimeout);
                DOM.previewOverlay.classList.add('hide');
                updateAssetListUI();
                notifyReady();
            };
            DOM.hiddenPlayersContainer.appendChild(audio);
            activePlayers[asset.id] = audio;
        } else {
            // 이미지 에셋
            clearTimeout(safetyTimeout);
            DOM.previewOverlay.classList.add('hide');
            updateAssetListUI();
            notifyReady();
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

// ── 릴스 불러오기 (vTonSales 릴스 저장 폴더 연동) ─────────────────────────
let reelsList = [];
let reelsFolders = [];
let currentReelsFolder = '';   // '' = 전체 릴스, 그 외 = 의류 폴더명

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// #rrggbb + 투명도(%) → rgba() 문자열 (자막 프리뷰용)
function hexToRgba(hex, opacityPercent) {
    const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const pct = (opacityPercent === undefined || isNaN(opacityPercent)) ? 100 : opacityPercent;
    const a = Math.max(0, Math.min(100, pct)) / 100;
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

async function loadReels() {
    try {
        const res = await fetch('/api/reels/list', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        reelsList = data.reels || [];
        reelsFolders = data.folders || [];
    } catch (e) {
        // 서버 미가동(파일 단독 열기 모드) 시 조용히 실패
        console.warn('[LookVideoEditor] 릴스 목록 로드 실패:', e.message);
        reelsList = [];
        reelsFolders = [];
    }
    renderReelsFolderSelect();
    renderReelsGrid();
}

// 의류 폴더 선택 셀렉트 갱신 (SNSReelsPostor STEP 1 패턴)
function renderReelsFolderSelect() {
    const sel = document.getElementById('reels-folder-select');
    if (!sel) return;

    const prevValue = currentReelsFolder;
    sel.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = `전체 릴스 (${reelsList.length})`;
    sel.appendChild(allOpt);

    reelsFolders.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.name;
        const label = f.displayName && f.displayName !== f.name
            ? `${f.name} · ${f.displayName}`
            : f.name;
        opt.textContent = `${label}${f.category ? ' · ' + f.category : ''} (${f.count > 0 ? f.count : '릴스 없음'})`;
        sel.appendChild(opt);
    });

    // 새로고침 후에도 기존 선택 유지 (삭제된 폴더면 전체로 복귀)
    if (prevValue && reelsFolders.some(f => f.name === prevValue)) {
        sel.value = prevValue;
    } else {
        currentReelsFolder = '';
    }
}

function renderReelsGrid() {
    const grid = document.getElementById('reels-grid');
    if (!grid) return;

    const list = currentReelsFolder
        ? reelsList.filter(r => r.product === currentReelsFolder)
        : reelsList;

    if (list.length === 0) {
        grid.innerHTML = currentReelsFolder
            ? '<div class="empty-list-msg">이 폴더에는 릴스가 없습니다.</div>'
            : '<div class="empty-list-msg">릴스가 없습니다.<br>(룩북 스튜디오에서 릴스 생성 후 새로고침)</div>';
        return;
    }

    grid.innerHTML = '';
    list.forEach(reel => {
        const card = document.createElement('div');
        card.className = 'reel-card';
        card.title = reel.name;

        const thumb = document.createElement('div');
        thumb.className = 'reel-thumb';
        if (reel.poster) {
            thumb.innerHTML = `<img src="${escapeHtml(reel.poster)}" alt="" loading="lazy">`;
        } else {
            thumb.innerHTML = `<video src="${escapeHtml(reel.url)}#t=0.001" preload="metadata" muted playsinline></video>`;
        }

        const sizeMb = (reel.size / (1024 * 1024)).toFixed(1);
        const meta = document.createElement('div');
        meta.className = 'reel-meta';
        meta.innerHTML = `
            <div class="reel-name" title="${escapeHtml(reel.name)}">${escapeHtml(reel.name)}</div>
            <div class="reel-info">${reel.product ? escapeHtml(reel.product) + ' · ' : ''}${sizeMb}MB</div>
        `;

        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary reel-add-btn';
        btn.textContent = '타임라인에 추가';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            addReelToEditor(reel);
        });

        card.appendChild(thumb);
        card.appendChild(meta);
        card.appendChild(btn);
        grid.appendChild(card);
    });
}

let hasAutoSwitchedToPortrait = false;

// 에셋용 숨김 미디어 플레이어 생성 (프리뷰 메타데이터/프레임 로드)
function createHiddenPlayerForAsset(asset) {
    if (activePlayers[asset.id] || asset.isPreviewDisabled) return;

    if (asset.type === 'video') {
        const video = document.createElement('video');
        video.src = asset.url;
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';

        video.onloadedmetadata = () => {
            asset.duration = video.duration || asset.duration || 10.0;
            updateAssetListUI();
            updateTimelineClipsUI();
            // 첫 프레임 강제 디코딩을 위해 0.001초로 시크
            try {
                if (video.currentTime === 0) video.currentTime = 0.001;
            } catch (e) {}
            renderPreview();
        };
        video.addEventListener('loadeddata', () => {
            renderPreview();
        });
        video.addEventListener('canplay', () => {
            renderPreview();
        });
        video.addEventListener('seeked', () => {
            if (!STATE.isPlaying) renderPreview();
        });
        video.onerror = () => {
            console.warn('[LookVideoEditor] 미디어 프리뷰 로드 실패:', asset.name);
            asset.isPreviewDisabled = true;
            updateAssetListUI();
        };
        DOM.hiddenPlayersContainer.appendChild(video);
        activePlayers[asset.id] = video;
    } else if (asset.type === 'audio') {
        const audio = document.createElement('audio');
        audio.src = asset.url;
        audio.preload = 'metadata';

        audio.onloadedmetadata = () => {
            asset.duration = audio.duration || asset.duration || 10.0;
            updateAssetListUI();
            updateTimelineClipsUI();
        };
        audio.onerror = () => {
            console.warn('[LookVideoEditor] 오디오 프리뷰 로드 실패:', asset.name);
            asset.isPreviewDisabled = true;
        };
        DOM.hiddenPlayersContainer.appendChild(audio);
        activePlayers[asset.id] = audio;
    }
}

function addReelToEditor(reel) {
    // 중복 체크: 같은 소스 파일이 이미 라이브러리에 있으면 재사용
    let asset = STATE.assets.find(a => a.localPath && a.localPath.toLowerCase() === reel.source.toLowerCase());

    if (!asset) {
        const id = 'asset_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        asset = {
            id,
            name: reel.name,
            type: 'video',
            duration: 5.0,
            url: reel.url,
            file: null,          // file:null → 서버 업로드 자동 스킵 (localPath 그대로 FFmpeg 입력)
            localPath: reel.source
        };
        STATE.assets.push(asset);
    } else if (!asset.url) {
        // 프로젝트 로드 등으로 URL이 없는 에셋 → 현재 서버의 릴스 경로로 재연결
        asset.url = reel.url;
    }

    // 숨김 플레이어 생성 (없는 경우만)
    createHiddenPlayerForAsset(asset);

    // 타임라인 끝에 연속 배치
    addAssetToTimeline(asset.id, 'video1', getProjectContentDuration());

    // 릴스는 세로 9:16 영상 → 프로젝트 해상도 자동 세로 전환 (최초 1회 안내)
    if (!hasAutoSwitchedToPortrait && !(STATE.outputWidth === 1080 && STATE.outputHeight === 1920)) {
        hasAutoSwitchedToPortrait = true;
        DOM.projectResolution.value = '1080x1920';
        updatePreviewResolution();
        alert('릴스는 세로 9:16 영상입니다.\n프로젝트 해상도를 1080 x 1920(세로)으로 자동 전환했습니다.');
    }

    updateAssetListUI();
}

// ── 외부 영상 로드 및 관리 ─────────────────────────────────────────────
function toggleExternalVideoMenu(show) {
    if (!DOM.externalVideoMenu) return;
    const isHidden = DOM.externalVideoMenu.classList.contains('hide');
    const target = show !== undefined ? show : isHidden;
    if (target) {
        DOM.externalVideoMenu.classList.remove('hide');
    } else {
        DOM.externalVideoMenu.classList.add('hide');
    }
}

async function openExternalVideoFiles() {
    toggleExternalVideoMenu(false);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch('/api/dialog/open-video', { method: 'POST', signal: ctrl.signal });
        clearTimeout(t);
        const data = await res.json();
        if (data.success && data.files && data.files.length > 0) {
            handleExternalVideosAdded(data.files, pathDirname(data.files[0].source));
            return;
        }
    } catch (e) {
        clearTimeout(t);
        console.warn('Windows 파일 다이얼로그 응답 없음/실패, 브라우저 파일 선택기 폴백:', e.message);
    }
    // 브라우저 파일 선택기 폴백
    if (DOM.inputExternalVideoFiles) DOM.inputExternalVideoFiles.click();
}

async function openExternalVideoFolder() {
    toggleExternalVideoMenu(false);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch('/api/dialog/open-folder', { method: 'POST', signal: ctrl.signal });
        clearTimeout(t);
        const data = await res.json();
        if (data.success && data.files && data.files.length > 0) {
            handleExternalVideosAdded(data.files, data.folder);
            return;
        } else if (data.folder && (!data.files || data.files.length === 0)) {
            alert(`선택한 폴더에 지원되는 동영상 파일(.mp4, .mov, .webm, .avi, .mkv)이 없습니다:\n${data.folder}`);
            return;
        }
    } catch (e) {
        clearTimeout(t);
        console.warn('Windows 폴더 다이얼로그 응답 없음/실패, 폴더 경로 입력 모달 폴백:', e.message);
    }
    // 폴더 경로 입력 모달 폴백
    openPathModal();
}

function openPathModal() {
    toggleExternalVideoMenu(false);
    if (!DOM.pathInputModal) return;
    DOM.pathInputModal.classList.remove('hide');
    renderRecentFolderChips();
    if (DOM.inputFolderPath) {
        DOM.inputFolderPath.value = '';
        setTimeout(() => DOM.inputFolderPath.focus(), 100);
    }
}

function renderRecentFolderChips() {
    const container = document.getElementById('recent-folders-chips');
    if (!container) return;
    container.innerHTML = '';

    const suggestions = [
        'D:\\LOOKLOOKLOOK\\참고동영상\\실외룩북',
        'D:\\LOOKLOOKLOOK\\homepage\\vTonSales\\samples\\_colorconvertor\\reels'
    ];

    if (Array.isArray(reelsFolders)) {
        reelsFolders.forEach(f => {
            if (f.isExternal && f.name && !suggestions.includes(f.name)) {
                suggestions.push(f.name);
            }
        });
    }

    suggestions.forEach(folderPath => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'btn btn-sm btn-outline';
        item.style.cssText = 'text-align: left; padding: 6px 10px; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 8px;';
        item.innerHTML = `<i class="fa-solid fa-folder" style="color: var(--accent);"></i> <span style="overflow: hidden; text-overflow: ellipsis;">${escapeHtml(folderPath)}</span>`;
        item.title = folderPath;
        item.addEventListener('click', () => {
            if (DOM.inputFolderPath) {
                DOM.inputFolderPath.value = folderPath;
            }
            confirmPathModal();
        });
        container.appendChild(item);
    });
}

function closePathModal() {
    if (!DOM.pathInputModal) return;
    DOM.pathInputModal.classList.add('hide');
}

async function confirmPathModal() {
    if (!DOM.inputFolderPath) return;
    const p = DOM.inputFolderPath.value.trim();
    if (!p) {
        alert('폴더 경로를 입력하세요.');
        return;
    }
    await scanExternalFolderByPath(p);
}

async function scanExternalFolderByPath(folderPath) {
    try {
        const res = await fetch('/api/external-videos/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await res.json();
        if (data.success && data.files && data.files.length > 0) {
            handleExternalVideosAdded(data.files, data.folder);
            closePathModal();
        } else if (data.success) {
            alert(`해당 폴더에 지원되는 동영상 파일이 없습니다:\n${data.folder}`);
        } else {
            alert(`폴더 로드 실패: ${data.error || '폴더를 찾을 수 없습니다.'}`);
        }
    } catch (e) {
        alert('서버 통신 실패: ' + e.message);
    }
}

function pathDirname(filePath) {
    if (!filePath) return '';
    const parts = filePath.split(/[\\/]/);
    parts.pop();
    return parts.join('\\');
}

function handleExternalVideosAdded(files, switchFolder = null) {
    if (!files || files.length === 0) return;
    let addedCount = 0;
    files.forEach(reel => {
        const key = reel.source.toLowerCase();
        const existingIdx = reelsList.findIndex(r => r.source.toLowerCase() === key);
        if (existingIdx !== -1) {
            reelsList[existingIdx] = reel;
        } else {
            reelsList.unshift(reel);
            addedCount++;
        }
    });

    if (switchFolder) {
        currentReelsFolder = switchFolder;
        if (!reelsFolders.some(f => f.name === switchFolder)) {
            const folderName = switchFolder.split(/[\\/]/).filter(Boolean).pop() || switchFolder;
            reelsFolders.unshift({
                name: switchFolder,
                displayName: `[외부] ${folderName}`,
                category: '외부 폴더',
                count: files.length,
                isExternal: true
            });
        }
    }

    renderReelsFolderSelect();
    renderReelsGrid();
}

// ── 타임라인 현재 장면 사진 추출 ─────────────────────────────────────
let lastExtractedPhoto = null;

async function extractScenePhoto() {
    // 1. 타임라인에 클립이 존재하는지 확인
    if (!STATE.clips || STATE.clips.length === 0) {
        alert('타임라인에 비디오 클립이 없습니다. 먼저 영상을 타임라인에 추가해 주세요.');
        return;
    }

    const time = STATE.playheadTime;

    // 2. 현재 재생헤드 시점의 비디오 클립 탐색
    let targetClip = null;
    if (STATE.selectedClipId) {
        const sel = STATE.clips.find(c => c.id === STATE.selectedClipId && (c.track === 'video1' || c.track === 'video2'));
        if (sel) targetClip = sel;
    }
    if (!targetClip) {
        targetClip = STATE.clips.find(c => c.track === 'video1' && time >= c.timelineStart && time <= c.timelineStart + c.duration);
    }
    if (!targetClip) {
        targetClip = STATE.clips.find(c => c.track === 'video2' && time >= c.timelineStart && time <= c.timelineStart + c.duration);
    }
    if (!targetClip) {
        targetClip = STATE.clips.find(c => c.track === 'video1' || c.track === 'video2');
    }

    if (!targetClip) {
        alert('사진을 추출할 비디오 클립을 찾을 수 없습니다.');
        return;
    }

    // 3. 비디오 원본 파일 내의 실제 재생 시점 계산
    const clipElapsed = Math.max(0, time - targetClip.timelineStart);
    const speed = targetClip.speed || 1.0;
    const sourcePlayTime = Math.max(0, targetClip.sourceStart + clipElapsed * speed);

    // 4. 프리뷰 화면 셔터 플래시 애니메이션
    triggerShutterFlash();

    // 5. 브라우저 캔버스 데이터 추출 (폴백 및 즉시 미리보기용)
    let canvasData = null;
    try {
        canvasData = DOM.previewCanvas.toDataURL('image/png');
    } catch (e) {
        console.warn('Canvas toDataURL failed:', e);
    }

    // 6. 서버로 추출 및 저장 요청 (해당 동영상 폴더 안의 '추출사진' 폴더로 저장)
    try {
        const payload = {
            videoPath: targetClip.localPath || '',
            timestamp: sourcePlayTime,
            rotation: targetClip.rotation || 0,
            clipName: targetClip.name || 'video',
            canvasData: canvasData
        };

        const res = await fetch('/api/extract-frame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || '사진 추출에 실패했습니다.');
        }

        lastExtractedPhoto = data;
        showPhotoExtractToast(data, canvasData);
    } catch (err) {
        console.error('Frame extraction failed:', err);
        alert('사진 추출 오류: ' + err.message);
    }
}

function triggerShutterFlash() {
    const flash = DOM.shutterFlash;
    if (!flash) return;
    flash.classList.remove('hide');
    flash.classList.remove('animate');
    void flash.offsetWidth; // Force reflow
    flash.classList.add('animate');
    setTimeout(() => {
        flash.classList.add('hide');
        flash.classList.remove('animate');
    }, 350);
}

function showPhotoExtractToast(data, fallbackImgUrl) {
    const toast = DOM.photoExtractToast;
    if (!toast) return;

    if (DOM.toastPhotoImg) {
        DOM.toastPhotoImg.src = data.url || fallbackImgUrl || '';
    }
    if (DOM.toastPhotoFilename) {
        DOM.toastPhotoFilename.textContent = data.filename;
        DOM.toastPhotoFilename.title = data.savedPath;
    }
    if (DOM.toastPhotoFolder) {
        DOM.toastPhotoFolder.textContent = data.folder;
        DOM.toastPhotoFolder.title = data.folder;
    }

    toast.classList.remove('hide');
    void toast.offsetWidth; // Force reflow
    toast.classList.add('show');

    if (window._extractToastTimer) clearTimeout(window._extractToastTimer);
    window._extractToastTimer = setTimeout(() => {
        hidePhotoExtractToast();
    }, 7000);
}

function hidePhotoExtractToast() {
    const toast = DOM.photoExtractToast;
    if (!toast) return;
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hide'), 300);
}

async function openExtractedPhotoFolder() {
    if (!lastExtractedPhoto) return;
    try {
        await fetch('/api/open-extracted-photo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: lastExtractedPhoto.savedPath })
        });
    } catch (e) {
        console.error('Open folder error:', e);
    }
}

function initReelsLoader() {
    const refreshBtn = document.getElementById('btn-refresh-reels');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadReels);
    }
    const folderSelect = document.getElementById('reels-folder-select');
    if (folderSelect) {
        folderSelect.addEventListener('change', () => {
            currentReelsFolder = folderSelect.value;
            renderReelsGrid();
        });
    }

    // 외부 영상 불러오기 버튼 및 메뉴
    if (DOM.btnOpenExternalVideo) {
        DOM.btnOpenExternalVideo.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExternalVideoMenu();
        });
    }
    document.addEventListener('click', (e) => {
        if (DOM.externalVideoMenu && !DOM.externalVideoMenu.classList.contains('hide')) {
            if (!DOM.externalVideoMenu.contains(e.target) && e.target !== DOM.btnOpenExternalVideo) {
                toggleExternalVideoMenu(false);
            }
        }
    });
    if (DOM.btnExtSelectFiles) {
        DOM.btnExtSelectFiles.addEventListener('click', openExternalVideoFiles);
    }
    if (DOM.btnExtSelectFolder) {
        DOM.btnExtSelectFolder.addEventListener('click', openExternalVideoFolder);
    }
    if (DOM.btnExtInputPath) {
        DOM.btnExtInputPath.addEventListener('click', openPathModal);
    }
    if (DOM.inputExternalVideoFiles) {
        DOM.inputExternalVideoFiles.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                handleMediaImport(e.target.files);
                e.target.value = '';
            }
        });
    }

    // 외부 경로 입력 모달
    if (DOM.btnClosePathModal) DOM.btnClosePathModal.addEventListener('click', closePathModal);
    if (DOM.btnCancelPathModal) DOM.btnCancelPathModal.addEventListener('click', closePathModal);
    if (DOM.btnConfirmPathModal) DOM.btnConfirmPathModal.addEventListener('click', confirmPathModal);
    if (DOM.inputFolderPath) {
        DOM.inputFolderPath.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmPathModal();
            else if (e.key === 'Escape') closePathModal();
        });
    }

    // 사진 추출 버튼
    if (DOM.btnPlayerCapture) {
        DOM.btnPlayerCapture.addEventListener('click', extractScenePhoto);
    }
    if (DOM.btnTimelineCapture) {
        DOM.btnTimelineCapture.addEventListener('click', extractScenePhoto);
    }
    if (DOM.btnToastOpenFolder) {
        DOM.btnToastOpenFolder.addEventListener('click', openExtractedPhotoFolder);
    }
    if (DOM.btnToastClose) {
        DOM.btnToastClose.addEventListener('click', hidePhotoExtractToast);
    }

    // 키보드 단축키 'C' (Capture) 또는 'P' (Photo)
    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (e.key === 'c' || e.key === 'C' || e.key === 'p' || e.key === 'P') {
            if (!e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                extractScenePhoto();
            }
        }
    });

    loadReels();
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
    if (asset.type === 'image' && trackType !== 'overlay' && trackType !== 'video1') {
        alert("이미지는 Overlay Track(스티커) 또는 Video Track 1(정지 구간)에 배치할 수 있습니다.");
        return;
    }

    const clipId = 'clip_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

    // 클립 길이 결정
    //  - 이미지 : 5초 고정 (기존 관례)
    //  - 오디오 : 10초 상한을 없앤다. 다만 음악이 영상보다 길면 영상 길이에 맞춰 자른다.
    //             (그냥 두면 타임라인이 음악 길이만큼 늘어나 뒤쪽이 검은 화면이 된다)
    //  - 비디오 : 기존과 동일하게 10초까지
    const assetDur = (Number.isFinite(asset.duration) && asset.duration > 0) ? asset.duration : 5.0;
    let duration;
    if (asset.type === 'image') {
        duration = 5.0;
    } else if (asset.type === 'audio') {
        const remain = getProjectContentDuration() - timelineStart;
        duration = (remain > 0.1) ? Math.min(assetDur, remain) : assetDur;
    } else {
        duration = Math.min(assetDur, 10.0);
    }

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
    } else if (trackType === 'video1' && asset.type === 'image') {
        // Video Track 1 위의 정지 이미지 = 정지 구간.
        // 생성기가 입력 스펙(-ss/-t 없이 -i, 오디오 분기 생략)을 다르게 만들어야 하므로 표시해 둔다.
        newClip.mediaType = 'image';
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

    let defaultFont = 'malgun';
    let defaultFontCustom = '';
    try {
        const savedFont = localStorage.getItem('look_last_text_font');
        if (savedFont) defaultFont = savedFont;
        const savedCustom = localStorage.getItem('look_last_text_font_custom');
        if (savedCustom) defaultFontCustom = savedCustom;
    } catch (e) {}

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
        textOpacity: 100,
        textEffect: 'none',
        textBgbox: 'off',
        textWeight: 'normal',
        textFont: defaultFont,
        textFontCustom: defaultFontCustom,
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

        let loopBadgeHtml = '';
        if (clip.loop === true) {
            loopBadgeHtml = `<span class="clip-loop-badge" title="반복 재생"><i class="fa-solid fa-repeat"></i></span>`;
        }

        // 정지 이미지 구간은 반복 배지를 쓰지 않는다 (이미 정지 상태라 의미가 없음)
        let stillBadgeHtml = '';
        if (clip.mediaType === 'image') {
            stillBadgeHtml = `<span class="clip-loop-badge" title="정지 이미지 구간"><i class="fa-solid fa-image"></i> 정지</span>`;
        }

        let displayName = clip.name;
        if (clip.overlayType === 'text') displayName = clip.text || '자막 텍스트';

        // 정지 이미지는 source in/out 개념이 없으므로 길이만 보여준다
        const durationInfoHtml = clip.mediaType === 'image'
            ? `${clip.duration.toFixed(1)}s`
            : `${clip.duration.toFixed(1)}s [${clip.sourceStart.toFixed(1)}~${clip.sourceEnd.toFixed(1)}]`;

        clipEl.innerHTML = `
            <div class="trim-handle trim-handle-left" data-handle="left"></div>
            <span class="clip-name">${displayName}</span>
            ${speedBadgeHtml}${loopBadgeHtml}${stillBadgeHtml}
            <span class="clip-duration-info">${durationInfoHtml}</span>
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

    updateWebpBand();
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
        if (DOM.propAudioLoop) DOM.propAudioLoop.checked = clip.loop === true;
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
            DOM.propTextOpacity.value = clip.textOpacity !== undefined ? clip.textOpacity : 100;
            if (DOM.propTextOpacityLabel) DOM.propTextOpacityLabel.textContent = `${DOM.propTextOpacity.value}%`;
            DOM.propTextEffect.value = clip.textEffect || 'none';
            DOM.propTextBgbox.value = clip.textBgbox || 'off';
            DOM.propTextWeight.value = clip.textWeight || 'normal';
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
            clip.textOpacity = parseInt(DOM.propTextOpacity.value);
            if (isNaN(clip.textOpacity)) clip.textOpacity = 100;
            clip.textEffect = DOM.propTextEffect.value;
            clip.textBgbox = DOM.propTextBgbox.value;
            clip.textWeight = DOM.propTextWeight.value;
            clip.textFont = DOM.propTextFont.value;
            clip.textFontCustom = DOM.propTextFontCustom.value;
            try {
                localStorage.setItem('look_last_text_font', clip.textFont);
                if (clip.textFontCustom) {
                    localStorage.setItem('look_last_text_font_custom', clip.textFontCustom);
                }
            } catch (e) {}
            if (DOM.propTextOpacityLabel) DOM.propTextOpacityLabel.textContent = `${clip.textOpacity}%`;
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
    updateWebpBand();
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

/**
 * 플레이헤드 시각에 대응하는 "소스 파일 안에서의 재생 위치"를 계산한다.
 * 반복 재생(loop) 클립은 소스 길이로 나눈 나머지를 써야 끝에서 멈추지 않는다.
 * updateActivePlayersStates / syncHiddenPlayersTime 이 공유한다.
 */
function getClipSourceTime(clip, playheadTime) {
    const speed = clip.speed || 1.0;
    const elapsed = Math.max(0, playheadTime - clip.timelineStart) * speed;
    const sourceStart = clip.sourceStart || 0;
    const sourceDur = (clip.sourceEnd || clip.duration) - sourceStart;
    if (clip.loop && sourceDur > 0.05) {
        return sourceStart + (elapsed % sourceDur);
    }
    return sourceStart + elapsed;
}

// 타임라인 총 길이 재계산
function recalculateTotalDuration() {
    const contentDur = getProjectContentDuration();
    STATE.totalDuration = contentDur > 0 ? contentDur : 10.0;
    drawRuler();
    updateTimeDisplay();
    updateWebpBand();   // 타임라인 길이가 바뀌면 구간도 유효 범위로 다시 맞춘다
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
    updateWebpBand();
    drawRuler();
}

/* ========================================================================
   WebP 내보내기 구간 밴드 (최대 5초)
   ======================================================================== */

// 구간 값을 유효 범위(0 이상, 0.5~5초, 타임라인 길이 이내)로 정규화한다.
function clampWebpRange() {
    const range = STATE.webpRange;
    const total = getProjectContentDuration() || STATE.totalDuration || 0;

    range.duration = Math.min(Math.max(WEBP_MIN_DURATION, range.duration), WEBP_MAX_DURATION);
    if (total > 0) {
        range.duration = Math.min(range.duration, total);
        range.start = Math.max(0, Math.min(range.start, total - range.duration));
    } else {
        range.start = 0;
    }
    range.start = Math.max(0, parseFloat(range.start.toFixed(3)));
    range.duration = parseFloat(range.duration.toFixed(3));
    return range;
}

// 구간을 설정하고 밴드를 다시 그린다.
function setWebpRange(start, duration) {
    STATE.webpRange.start = start;
    STATE.webpRange.duration = duration;
    clampWebpRange();
    updateWebpBand();
}

function toggleWebpEditMode(forceState) {
    if (STATE.clips.length === 0) {
        alert("타임라인에 최소 하나 이상의 클립이 있어야 WebP 구간을 편집할 수 있습니다.");
        return;
    }
    const targetState = (forceState !== undefined) ? !!forceState : !STATE.isWebpEditMode;
    STATE.isWebpEditMode = targetState;
    updateWebpEditModeUI();
    updateWebpBand();

    // 편집 모드가 켜지면 해당 구간이 화면에 보이도록 스크롤 이동
    if (STATE.isWebpEditMode && DOM.timelineScrollContainer) {
        const range = clampWebpRange();
        const startPx = range.start * STATE.timelineZoom;
        const scrollLeft = DOM.timelineScrollContainer.scrollLeft;
        const clientWidth = DOM.timelineScrollContainer.clientWidth - 160;
        if (startPx < scrollLeft || startPx > scrollLeft + clientWidth - 60) {
            DOM.timelineScrollContainer.scrollTo({
                left: Math.max(0, startPx - 40),
                behavior: 'smooth'
            });
        }
    }
}

function updateWebpEditModeUI() {
    const isEdit = !!STATE.isWebpEditMode;

    if (DOM.btnToggleWebpMode) {
        DOM.btnToggleWebpMode.classList.toggle('btn-webp-active', isEdit);
        DOM.btnToggleWebpMode.title = isEdit ? "WebP 구간 편집 모드 끄기" : "타임라인에 WebP 시간 구간 선택 컨트롤러 표시";
        DOM.btnToggleWebpMode.innerHTML = isEdit 
            ? '<i class="fa-solid fa-check"></i> WebP 편집 중'
            : '<i class="fa-solid fa-photo-film"></i> WebP 편집';
    }

    if (DOM.btnToggleWebpHeader) {
        DOM.btnToggleWebpHeader.classList.toggle('btn-webp-active', isEdit);
        DOM.btnToggleWebpHeader.title = isEdit ? "WebP 구간 편집 모드 끄기" : "타임라인에 WebP 시간 구간 선택 컨트롤러 표시";
        DOM.btnToggleWebpHeader.innerHTML = isEdit
            ? '<i class="fa-solid fa-check"></i> WebP 편집 중'
            : '<i class="fa-solid fa-sliders"></i> WebP 편집';
    }

    if (DOM.webpTimelineBadge) {
        DOM.webpTimelineBadge.classList.toggle('hide', !isEdit);
    }
}

// 밴드 위치/폭/라벨을 현재 구간에 맞춰 갱신한다.
function updateWebpBand() {
    const band = DOM.webpRangeBand;
    if (!band) return;

    // 클립이 없으면 내보낼 구간 자체가 없으므로 모드도 해제하고 숨김
    if (STATE.clips.length === 0) {
        STATE.isWebpEditMode = false;
        updateWebpEditModeUI();
        band.classList.add('hide');
        return;
    }

    // WebP 편집 모드가 아니면 숨김
    if (!STATE.isWebpEditMode) {
        band.classList.add('hide');
        if (DOM.webpTimelineBadge) DOM.webpTimelineBadge.classList.add('hide');
        return;
    }

    band.classList.remove('hide');
    if (DOM.webpTimelineBadge) DOM.webpTimelineBadge.classList.remove('hide');

    const range = clampWebpRange();
    const zoom = STATE.timelineZoom;
    const widthPx = range.duration * zoom;

    band.style.transform = `translateX(${range.start * zoom}px)`;
    band.style.width = `${widthPx}px`;
    band.classList.toggle('too-narrow', widthPx < 76);

    const labelText = `WebP ${range.duration.toFixed(1)}초`;
    if (DOM.webpRangeLabelText) {
        DOM.webpRangeLabelText.textContent = labelText;
    } else if (DOM.webpRangeLabel) {
        DOM.webpRangeLabel.textContent = labelText;
    }

    if (DOM.webpTimelineRangeText) {
        DOM.webpTimelineRangeText.textContent = `${range.start.toFixed(1)}초 ~ ${(range.start + range.duration).toFixed(1)}초 (${range.duration.toFixed(1)}초)`;
    }

    if (DOM.webpModal && DOM.webpModal.classList.contains('show')) {
        updateWebpModalReadout();
    }
}

// 밴드 드래그: 왼쪽/오른쪽 핸들로 양 끝 조정, 몸통으로 구간 전체 이동.
// 최대 5초를 넘기려 하면 반대쪽 끝이 밀려나 창이 미끄러진다(멈칫하지 않게).
function initWebpBandDrag(e, mode) {
    e.preventDefault();
    e.stopPropagation();

    const range = clampWebpRange();
    const startX = e.clientX;
    const origStart = range.start;
    const origDuration = range.duration;

    function onMouseMove(moveE) {
        const deltaSec = (moveE.clientX - startX) / STATE.timelineZoom;
        const total = getProjectContentDuration() || STATE.totalDuration || 0;
        const maxStart = Math.max(0, total - WEBP_MIN_DURATION);

        let newStart = origStart;
        let newEnd = origStart + origDuration;

        if (mode === 'move') {
            newStart = Math.max(0, Math.min(origStart + deltaSec, Math.max(0, total - origDuration)));
            newEnd = newStart + origDuration;
        } else if (mode === 'left') {
            newStart = Math.max(0, origStart + deltaSec);
            newEnd = origStart + origDuration;
            if (newEnd - newStart > WEBP_MAX_DURATION) {
                newEnd = newStart + WEBP_MAX_DURATION;   // 5초 상한 → 오른쪽이 밀려남
            }
            if (total > 0 && newEnd > total) {
                newEnd = total;
                newStart = Math.max(0, newEnd - WEBP_MAX_DURATION);
            }
        } else {  // 'right'
            newEnd = Math.max(0, origStart + origDuration + deltaSec);
            newStart = origStart;
            if (newEnd - newStart > WEBP_MAX_DURATION) {
                newStart = newEnd - WEBP_MAX_DURATION;   // 5초 상한 → 왼쪽이 밀려남
            }
            if (newStart < 0) {
                newStart = 0;
                newEnd = Math.min(total || WEBP_MAX_DURATION, WEBP_MAX_DURATION);
            }
            if (total > 0 && newEnd > total) {
                newEnd = total;
                newStart = Math.max(0, Math.min(newStart, newEnd - WEBP_MIN_DURATION));
            }
        }

        newStart = Math.max(0, Math.min(newStart, maxStart));
        STATE.webpRange.start = newStart;
        STATE.webpRange.duration = Math.max(WEBP_MIN_DURATION, newEnd - newStart);
        updateWebpBand();
    }

    function onMouseUp() {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        clampWebpRange();
        updateWebpBand();
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
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
    // 타임라인 재생을 시작하면 음악 미리듣기는 겹치지 않게 멈춘다
    stopMusicPreview();
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
            const speed = activeClip.speed || 1.0;
            const targetTime = getClipSourceTime(activeClip, time);

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
            if (player.readyState >= 1) {
                try {
                    player.currentTime = getClipSourceTime(activeClip, time);
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
    //    겹치는 클립은 ffmpeg 렌더와 동일하게 크로스디졸브로 합성한다.
    //    (겹침 계산은 ffmpeg-generator.js 의 computeVideo1Transitions 를 그대로 공유한다)
    const v1Transitions = computeVideo1Transitions(STATE.clips, STATE.outputFps);
    const v1Active = STATE.clips
        .filter(c => c.track === 'video1' && time >= c.timelineStart && time < c.timelineStart + c.duration)
        .sort((a, b) => a.timelineStart - b.timelineStart);

    v1Active.forEach(clip => {
        const trans = v1Transitions[clip.id];
        ctx.globalAlpha = (trans && trans.fadeIn > 0)
            ? Math.max(0, Math.min(1, (time - clip.timelineStart) / trans.fadeIn))
            : 1;
        drawVideoClip(clip, time, 0, 0, canvasW, canvasH, true);
        ctx.globalAlpha = 1;
    });

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
        
        // PIP 는 ffmpeg 가 scale=${pipW}:${pipH} 로 늘려 그리므로 레터박스를 끼우지 않는다
        drawVideoClip(v2Clip, time, px, py, pw, ph, false);
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
            ctx.fillStyle = hexToRgba(clip.textColor || '#ffffff', clip.textOpacity);
            const fontFamily = getCanvasFontFamily(clip.textFont);
            const fontSize = Math.round((clip.textSize || 36) * scale);
            const fontWeight = clip.textWeight === 'bold' ? 700 : 500;
            ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

            const textEffect = clip.textEffect || 'none';
            const hasShadow = textEffect === 'shadow' || textEffect === 'outline_shadow';
            const hasOutline = textEffect === 'outline' || textEffect === 'outline_shadow';
            if (hasShadow) {
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 6;
            } else {
                ctx.shadowBlur = 0;
            }

            const textX = clip.x === 640 ? canvasW / 2 : (clip.x * (canvasW / 1280));
            const textY = clip.y * (canvasH / 720);

            // 여러 줄 처리: 캔버스 fillText 는 \n 을 줄바꿈으로 처리하지 않으므로 직접 나눠 그린다.
            // \r 은 렌더 쪽에서 두부(□)로 보이므로 여기서도 똑같이 제거한다.
            // 줄 간격 TEXT_LINE_SPACING 은 ffmpeg-generator.js 가 정의한 값을 그대로 공유한다
            // (스크립트 로드 순서상 generator 가 먼저라 전역으로 접근 가능).
            const lines = String(clip.text || '').replace(/\r/g, '').split('\n');
            const lineHeight = fontSize * TEXT_LINE_SPACING;
            const lineCount = lines.length;
            const lineY = (li) => textY + (li - (lineCount - 1) / 2) * lineHeight;

            ctx.textAlign = clip.x === 640 ? 'center' : 'left';
            ctx.textBaseline = 'middle';

            // 배경 상자 (textBgbox === 'on'일 때 프리뷰 캔버스에도 동일하게 렌더링)
            // 여러 줄이면 가장 넓은 줄 기준으로 전체 줄을 감싼다
            if (clip.textBgbox === 'on') {
                let textW = 0;
                lines.forEach(l => { textW = Math.max(textW, ctx.measureText(l).width); });
                const padX = 10 * scale;
                const padY = 6 * scale;
                const bgW = textW + padX * 2;
                const bgH = (lineCount - 1) * lineHeight + fontSize + padY * 2;
                const bgX = (clip.x === 640) ? (textX - textW / 2 - padX) : (textX - padX);
                const bgY = textY - (bgH / 2);

                ctx.save();
                ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.fillRect(bgX, bgY, bgW, bgH);
                ctx.restore();
            }

            if (hasOutline) {
                ctx.strokeStyle = 'rgba(0,0,0,0.9)';
                ctx.lineWidth = Math.max(2, fontSize * 0.06);
            }

            lines.forEach((line, li) => {
                const ly = lineY(li);
                ctx.fillText(line, textX, ly);
                if (hasOutline) ctx.strokeText(line, textX, ly);
            });

            ctx.shadowBlur = 0;
        }
    });
}

/**
 * ffmpeg 의 scale + pad 와 같은 규칙으로 안쪽(레터박스) 사각형을 계산한다.
 * 소스 비율을 지키고 남는 쪽에 검은 여백을 두는 것이 렌더 결과와 같다.
 */
function fitLetterbox(srcW, srcH, dstW, dstH) {
    if (!srcW || !srcH) return { x: 0, y: 0, w: dstW, h: dstH };
    const srcAR = srcW / srcH;
    const dstAR = dstW / dstH;
    let w, h;
    if (srcAR >= dstAR) { w = dstW; h = dstW / srcAR; }
    else { h = dstH; w = dstH * srcAR; }
    return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}

// 정지 이미지 캐시. 매 프레임 new Image() 를 만들면 로딩 전 프레임이 비어 깜빡인다.
const assetImageCache = {};
function getAssetImage(asset) {
    if (!asset || !asset.url) return null;
    let entry = assetImageCache[asset.id];
    if (!entry || entry.url !== asset.url) {
        entry = { url: asset.url, img: new Image() };
        entry.img.src = asset.url;
        assetImageCache[asset.id] = entry;
    }
    return (entry.img.complete && entry.img.naturalWidth > 0) ? entry.img : null;
}

// 개별 비디오/정지이미지 그리기 + 필터 + 변환 엔진
//  letterbox=true 면 ffmpeg 처럼 원본 비율을 지키고 검은 여백을 둔다 (Video Track 1).
//  PIP 는 ffmpeg 가 늘려 그리므로 false 로 호출해 기존 모양을 유지한다.
function drawVideoClip(clip, time, x, y, w, h, letterbox) {
    const asset = STATE.assets.find(a => a.id === clip.assetId);
    const isStill = clip.mediaType === 'image';
    const player = isStill ? null : activePlayers[clip.assetId];
    const image = isStill ? getAssetImage(asset) : null;
    if (!player && !image) return;

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

    // 정지 이미지는 seek 할 플레이어가 없다 (프레임이 하나뿐)
    if (player && !STATE.isPlaying && !STATE.isRendering) {
        if (player.readyState >= 1) {
            try {
                const targetTime = sourcePlayTime === 0 ? 0.001 : sourcePlayTime;
                if (Math.abs(player.currentTime - targetTime) > 0.03) {
                    player.currentTime = targetTime;
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
            // 크로스디졸브 알파와 곱셈으로 합성한다 (대입하면 겹침 페이드가 덮여 사라진다)
            ctx.globalAlpha = ctx.globalAlpha * Math.max(0, 1.0 - progress);
        }
    }

    // 소스 픽셀 크기 (레터박스 계산용). 메타데이터 로딩 전이면 0 이라 전체 사각형으로 폴백된다.
    const srcW = player ? player.videoWidth : (image ? image.naturalWidth : 0);
    const srcH = player ? player.videoHeight : (image ? image.naturalHeight : 0);
    const fit = letterbox ? fitLetterbox(srcW, srcH, w, h) : { x: 0, y: 0, w, h };

    // 회전 렌더링 (중심은 레터박스 안쪽 사각형 기준)
    const cx = x + fit.x + fit.w / 2;
    const cy = y + fit.y + fit.h / 2;
    ctx.translate(cx, cy);

    if (clip.rotation !== 0) {
        ctx.rotate((clip.rotation * Math.PI) / 180);
    }

    // 줌 효과 계산
    let zoomScale = 1.0;
    if (clip.effects && clip.effects.includes('zoom_in')) zoomScale = 1.5;
    else if (clip.effects && clip.effects.includes('zoom_out')) zoomScale = 0.75;

    const drawW = fit.w * zoomScale;
    const drawH = fit.h * zoomScale;

    try {
        ctx.drawImage(player || image, -drawW / 2, -drawH / 2, drawW, drawH);
    } catch (e) {
        ctx.fillStyle = '#1a1a20';
        ctx.fillRect(-drawW / 2, -drawH / 2, drawW, drawH);
    }

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

// --- 프리뷰 확대/축소(휠) 및 화면 이동(드래그) ---
//  CSS transform 만 쓴다. 캔버스 비트맵은 손대지 않으므로
//  렌더 결과물과 브라우저 폴백 렌더(rCtx.drawImage)에는 영향이 없다.
//
//  transform: translate(pan) scale(zoom) + transform-origin 50% 50% 이므로
//  캔버스 로컬 좌표 u 는 화면에서  screen(u) = C0 + pan + zoom * (u - c)  로 매핑된다.
//  (C0 = 변환 전 캔버스 중심의 화면 좌표, c = 캔버스 로컬 중심)
let previewZoom = 1.0;
let previewPan = { x: 0, y: 0 };
const PREVIEW_ZOOM_MIN = 1.0;
const PREVIEW_ZOOM_MAX = 8.0;

function previewCanvasCenter() {
    // 캔버스는 래퍼의 콘텐츠 박스에 flex 중앙 정렬된다. 래퍼 패딩이 좌우대칭이라 중심이 일치한다.
    const r = DOM.previewCanvasWrapper.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// 확대 상태에서 화면을 너무 멀리 밀어내지 않도록 제한한다.
// 한계까지 밀면 캔버스 가장자리가 "확대 전 가장자리 위치"에 닿아 구석까지 볼 수 있다.
function clampPreviewPan() {
    const maxX = Math.max(0, (previewZoom - 1) * DOM.previewCanvas.offsetWidth / 2);
    const maxY = Math.max(0, (previewZoom - 1) * DOM.previewCanvas.offsetHeight / 2);
    previewPan.x = Math.max(-maxX, Math.min(maxX, previewPan.x));
    previewPan.y = Math.max(-maxY, Math.min(maxY, previewPan.y));
}

function applyPreviewTransform() {
    clampPreviewPan();
    DOM.previewCanvas.style.transform =
        `translate(${previewPan.x.toFixed(1)}px, ${previewPan.y.toFixed(1)}px) scale(${previewZoom.toFixed(4)})`;

    const zoomed = previewZoom > 1.001;
    DOM.previewCanvasWrapper.classList.toggle('zoomed', zoomed);
    if (DOM.previewZoomBadge) {
        DOM.previewZoomBadge.classList.toggle('show', zoomed);
        if (DOM.previewZoomText) {
            DOM.previewZoomText.textContent = `${Math.round(previewZoom * 100)}%`;
        }
    }
}

function resetPreviewZoom() {
    previewZoom = 1.0;
    previewPan = { x: 0, y: 0 };
    applyPreviewTransform();
}

function onPreviewWheel(e) {
    e.preventDefault();
    const prev = previewZoom;
    // 지수 스케일이라 마우스 휠과 트랙패드 모두 같은 느낌으로 동작한다
    const next = Math.max(PREVIEW_ZOOM_MIN,
                 Math.min(PREVIEW_ZOOM_MAX, prev * Math.exp(-e.deltaY * 0.0015)));
    if (Math.abs(next - prev) < 1e-4) return;

    // 커서 아래에 있던 지점이 확대 후에도 그 자리에 남도록 팬을 보정한다
    const c0 = previewCanvasCenter();
    const dx = e.clientX - c0.x;
    const dy = e.clientY - c0.y;
    const k = next / prev;
    previewPan.x = dx - k * (dx - previewPan.x);
    previewPan.y = dy - k * (dy - previewPan.y);

    previewZoom = next;
    applyPreviewTransform();
}

if (DOM.previewCanvasWrapper) {
    // passive: false 여야 preventDefault 로 페이지 스크롤을 막을 수 있다
    DOM.previewCanvasWrapper.addEventListener('wheel', onPreviewWheel, { passive: false });
}
if (DOM.previewCanvas) {
    DOM.previewCanvas.addEventListener('dblclick', (e) => {
        e.preventDefault();
        resetPreviewZoom();
    });
}
if (DOM.previewZoomBadge) {
    DOM.previewZoomBadge.addEventListener('click', resetPreviewZoom);
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
        return;
    }

    // 잡을 클립이 없고 확대 중이면 화면 이동(팬)
    if (previewZoom > 1.001) {
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const startPan = { x: previewPan.x, y: previewPan.y };

        const onPanMove = (me) => {
            previewPan.x = startPan.x + (me.clientX - startClientX);
            previewPan.y = startPan.y + (me.clientY - startClientY);
            applyPreviewTransform();
        };
        const onPanUp = () => {
            window.removeEventListener('mousemove', onPanMove);
            window.removeEventListener('mouseup', onPanUp);
        };
        window.addEventListener('mousemove', onPanMove);
        window.addEventListener('mouseup', onPanUp);
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
        encoder: STATE.encoder || 'h264_nvenc',
        reelsFolder: currentReelsFolder
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
    const isServerAvailable = await checkServerHealth();

    if (isServerAvailable) {
        // [모드 1] 로컬 서버를 통한 고속 FFmpeg 즉시 렌더링 실행
        runLocalServerRender(result);
    } else {
        // [모드 2] 브라우저 내장 클라이언트 사이드 즉시 렌더링 실행
        runBrowserClientRender();
    }
}

// 로컬 서버 가용 상태 확인 헬퍼
async function checkServerHealth() {
    try {
        const pingRes = await fetch('/api/ping', { method: 'GET', cache: 'no-store' });
        if (pingRes.ok) {
            const pingData = await pingRes.json();
            return pingData.status === 'ok';
        }
    } catch (e) {}
    return false;
}

// 로컬 서버로 에셋 파일 자동 동기화 업로드
async function uploadAssetFileToServer(asset) {
    if (!asset || !asset.file) return;
    try {
        const res = await fetch(`/api/upload?filename=${encodeURIComponent(asset.name)}`, {
            method: 'POST',
            body: asset.file
        });
        if (res.ok) {
            const data = await res.json();
            if (data.localPath) {
                asset.localPath = data.localPath;
                STATE.clips.filter(c => c.assetId === asset.id).forEach(c => {
                    c.localPath = data.localPath;
                });
                console.log(`[LookVideoEditor] 소스 파일 서버 동기화 완료: ${asset.name} -> ${data.localPath}`);
            }
        }
    } catch (e) {
        console.warn(`[LookVideoEditor] 소스 파일 업로드 건너뜀 (오프라인 또는 클라이언트 모드):`, e.message);
    }
}

// 모든 프로젝트 에셋이 로컬 서버의 source/ 폴더에 동기화되었는지 확인
async function ensureAssetsUploadedToLocalServer() {
    const isServer = await checkServerHealth();
    if (!isServer) return;
    for (const asset of STATE.assets) {
        if (asset.file) {
            await uploadAssetFileToServer(asset);
        }
    }
}

// [모드 1] 로컬 서버 FFmpeg 렌더링
async function runLocalServerRender(initialParams) {
    try {
        updateRenderModalUI({
            heading: "소스 미디어 파일 동기화 중...",
            desc: "로컬 FFmpeg 인코딩을 위해 소스 파일들을 서버로 동기화하고 있습니다.",
            engine: "로컬 미디어 동기화",
            status: "rendering"
        });

        // 1. 모든 에셋 파일을 로컬 서버 source/ 로 자동 동기화
        await ensureAssetsUploadedToLocalServer();

        // 2. 동기화된 최신 localPath 로 FFmpeg 파라미터 재생성
        const renderParams = generateFFmpegCommand({ ...STATE, reelsFolder: currentReelsFolder });
        if (renderParams.error) {
            throw new Error(renderParams.error);
        }

        const startRes = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command: renderParams.command,
                outputFile: renderParams.outputFile,
                totalDuration: getProjectContentDuration(),
                fps: STATE.outputFps,
                rawInputs: renderParams.rawInputs,
                filterComplex: renderParams.filterComplex,
                mappedVideo: renderParams.mappedVideo,
                mappedAudio: renderParams.mappedAudio,
                encoder: STATE.encoder
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

        const gifPhase = String((data.gif || {}).phase || '');
        const inGifStage = gifPhase.startsWith('gif_');

        // WebP 내보내기 진행 중이면 단계별 문구와 실시간 용량을 보여준다
        // (GIF 단계에서는 webp.phase 가 'final' 로 남아 있으므로 GIF 를 먼저 처리한다)
        if (data.status === 'rendering' && data.webp && !inGifStage) {
            const w = data.webp;
            const mb = (n) => (n / 1048576).toFixed(2);

            let desc = "애니메이션 WebP를 생성하고 있습니다.";
            if (w.phase === 'intermediate') desc = "합성 결과를 준비하고 있습니다 (중간본 생성).";
            else if (w.phase === 'search') {
                desc = `목표 용량에 맞는 품질을 탐색하고 있습니다 (${w.probes || 0}회 시험 인코딩).`;
            } else if (w.phase === 'final') {
                desc = `확정 인코딩 중입니다${w.attempt > 1 ? ` (재시도 ${w.attempt - 1})` : ''}.`;
            }

            const infoParts = [];
            if (w.width && w.height) infoParts.push(`${w.width}x${w.height}`);
            if (w.quality !== undefined) infoParts.push(`q=${w.quality}`);
            if (w.sizeBytes) infoParts.push(`현재 ${mb(w.sizeBytes)}MB`);

            updateRenderModalUI({
                progress: data.progress || 0,
                desc,
                currentTime: data.currentTime ? data.currentTime.slice(3, 8) : "00:00",
                totalTime: formatTimeShort(data.totalDuration || STATE.webpRange.duration),
                elapsed: data.elapsedTime,
                fpsInfo: infoParts.length ? infoParts.join(' · ') : `${data.fps || STATE.webpFps} fps`,
                status: "rendering"
            });
            return;
        }

        // GIF 동시 저장 단계가 진행 중이면 GIF 문구를 보여준다
        if (data.status === 'rendering' && inGifStage) {
            const g = data.gif;
            const mbGif = (n) => (n / 1048576).toFixed(2);

            let gifDesc = "GIF를 생성하고 있습니다.";
            if (g.phase === 'gif_try') {
                gifDesc = `GIF 설정 ${g.step || 1}/${g.totalSteps || 10} 단계로 인코딩하고 있습니다 ` +
                    `(목표 이하가 나오면 그 설정으로 저장).`;
            } else if (g.phase === 'gif_try_size') {
                gifDesc = `${g.step || 1}/${g.totalSteps || 10} 단계 결과 ${mbGif(g.sizeBytes || 0)}MB — ` +
                    `목표 ${mbGif(g.targetBytes || 0)}MB와 비교 중입니다.`;
            }

            const gifParts = [];
            if (g.width && g.height) gifParts.push(`${g.width}x${g.height}`);
            if (g.fps) gifParts.push(`${g.fps}fps`);
            if (g.colors) gifParts.push(`${g.colors}색`);
            if (g.sizeBytes) gifParts.push(`현재 ${mbGif(g.sizeBytes)}MB`);
            if (g.targetBytes) gifParts.push(`목표 ${mbGif(g.targetBytes)}MB`);

            updateRenderModalUI({
                progress: data.progress || 0,
                desc: gifDesc,
                currentTime: data.currentTime ? data.currentTime.slice(3, 8) : "00:00",
                totalTime: formatTimeShort(data.totalDuration || STATE.webpRange.duration),
                elapsed: data.elapsedTime,
                fpsInfo: gifParts.join(' · '),
                status: "rendering"
            });
            return;
        }

        if (data.status === 'rendering') {
            updateRenderModalUI({
                progress: data.progress || 0,
                currentTime: data.currentTime ? data.currentTime.slice(3, 8) : "00:00",
                totalTime: formatTimeShort(STATE.totalDuration),
                elapsed: data.elapsedTime,
                fpsInfo: `${data.fps || STATE.outputFps} fps (${data.speed || '1.0x'})`,
                status: "rendering"
            });
        } else if (data.status === 'needs_confirm') {
            // 목표 용량을 맞추려면 설정을 낮춰야 한다 — webP / GIF 중 어느 쪽인지 구분해 묻는다
            clearInterval(STATE.renderPollingTimer);
            STATE.renderPollingTimer = null;

            const isGifConfirm = !!(data.gif && data.gif.phase === 'needs_confirm');
            STATE.webpConfirmTarget = isGifConfirm ? 'gif' : 'webp';
            const w = isGifConfirm ? (data.gif || {}) : (data.webp || {});
            const suggestion = w.suggestion || null;
            STATE.webpSuggestion = suggestion;

            const mb = (n) => (n / 1048576).toFixed(2);

            if (isGifConfirm) {
                // GIF 는 사다리 최하단에서도 목표를 못 맞춘 상태 — 더 낮출 단계가 없다.
                // 정직하게 두 갈래(가장 낮은 설정으로 저장 / GIF 건너뛰기)를 제시한다.
                if (DOM.webpConfirmTitle) DOM.webpConfirmTitle.textContent = "GIF를 목표 용량에 맞출 수 없습니다";
                if (DOM.webpConfirmDownscale) DOM.webpConfirmDownscale.textContent = "🚫 GIF 건너뛰기 (webP만)";
                if (DOM.webpConfirmFloor) DOM.webpConfirmFloor.textContent = "가장 낮은 설정으로 저장";

                desc = `가장 낮은 설정(${w.width}x${w.height} · ${w.fps}fps · ${w.colors || 0}색)에서도 ` +
                       `<strong>${mb(w.floorSizeBytes || 0)}MB</strong>로 목표 ${mb(w.targetBytes || 0)}MB를 넘습니다.<br>` +
                       `GIF는 webP보다 원래 2~4배 큽니다. 가장 낮은 설정으로 저장하거나, ` +
                       `GIF를 건너뛰고 webP만 사용(쿠팡용)하세요.<br>` +
                       `<span class="webp-stat-note">💡 취소 후 <strong>재생 길이를 1~3초로 줄여</strong> 다시 내보내면 ` +
                       `같은 용량에서 화질을 지키며 목표에 맞출 수 있습니다.</span>`;
            } else {
                if (DOM.webpConfirmTitle) DOM.webpConfirmTitle.textContent = "해상도를 낮춰야 합니다";
                if (DOM.webpConfirmDownscale) DOM.webpConfirmDownscale.textContent = "낮춰서 진행";
                if (DOM.webpConfirmFloor) DOM.webpConfirmFloor.textContent = "현재 화질로 저장";

                desc = suggestion
                    ? `${w.width}x${w.height}에서는 목표 ${mb(w.targetBytes || 0)}MB를 맞출 수 없습니다 ` +
                      `(최소 ${mb(w.floorSizeBytes || 0)}MB).<br>` +
                      `<strong>${suggestion.width}x${suggestion.height}</strong>로 낮추면 ` +
                      `약 <strong>${mb(suggestion.estimatedBytes)}MB</strong>로 맞출 수 있습니다.`
                    : `목표 용량을 맞출 수 있는 해상도가 더 없습니다. 현재 화질로 저장하거나 취소해 주세요.`;
            }

            updateRenderModalUI({
                heading: isGifConfirm ? "GIF 용량 확인" : "해상도를 낮춰야 합니다",
                descHtml: desc,
                elapsed: data.elapsedTime,
                status: "needs_confirm"
            });

            if (DOM.webpConfirmBox) DOM.webpConfirmBox.classList.remove('hide');
            if (DOM.webpConfirmDownscale) {
                // GIF 확인에서는 '건너뛰기' 버튼이므로 숨기지 않는다
                DOM.webpConfirmDownscale.classList.toggle('hide', !suggestion && !isGifConfirm);
            }
        } else if (data.status === 'completed') {
            clearInterval(STATE.renderPollingTimer);
            STATE.renderPollingTimer = null;

            if (data.webp) {
                // WebP 결과는 <video> 로 재생되지 않으므로 <img> 로 보여준다
                const w = data.webp;
                const gifSkipped = !!(data.gif && data.gif.phase === 'skipped');
                const g = data.gif && data.gif.phase === 'completed' ? data.gif : null;
                STATE.activeRenderGif = g ? (data.gifFile || null) : null;
                updateRenderModalUI({
                    progress: 100,
                    heading: g ? "WebP + GIF 내보내기 완료!" : "WebP 내보내기 완료!",
                    desc: g
                        ? "애니메이션 WebP와 GIF가 함께 생성되었습니다 (쇼핑몰별로 맞는 파일을 사용하세요)."
                        : (gifSkipped
                            ? "애니메이션 WebP가 생성되었습니다. GIF는 건너뛰었습니다."
                            : "애니메이션 WebP가 생성되었습니다."),
                    outputFile: data.outputFile || STATE.activeRenderOutput,
                    outputUrl: data.outputUrl,
                    gifFile: data.gifFile || null,
                    gifUrl: data.gifUrl || null,
                    elapsed: data.elapsedTime,
                    isAnimatedImage: true,
                    metaRes: `${w.width} x ${w.height}`,
                    webpStats: {
                        width: w.width,
                        height: w.height,
                        quality: w.quality,
                        sizeBytes: w.sizeBytes,
                        targetBytes: w.targetBytes,
                        exceededTarget: w.exceededTarget,
                        probes: w.probes,
                        duration: STATE.webpRange.duration,
                        gif: g ? {
                            fps: g.fps,
                            width: g.width,
                            height: g.height,
                            colors: g.colors,
                            sizeBytes: g.sizeBytes,
                            targetBytes: g.targetBytes,
                            exceededTarget: g.exceededTarget,
                            // 0 = 선택 구간 전체 (서버가 실제 적용한 재생 길이)
                            duration: g.duration || 0,
                            rangeDuration: STATE.webpRange.duration
                        } : null
                    },
                    status: "completed"
                });
            } else {
                updateRenderModalUI({
                    progress: 100,
                    heading: "렌더링 완료!",
                    desc: "성공적으로 고화질 비디오 렌더링이 완료되었습니다.",
                    outputFile: data.outputFile || STATE.activeRenderOutput,
                    outputUrl: data.outputUrl,   // reels 폴더 저장 결과물의 스트리밍 URL
                    elapsed: data.elapsedTime,
                    status: "completed"
                });
            }
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

// 비디오 엘리먼트 비동기 Seek 완료 및 프레임 디코딩 대기 헬퍼
function waitPlayerSeek(player, targetTime) {
    return new Promise(resolve => {
        let isDone = false;
        let timer = null;
        
        const done = () => {
            if (isDone) return;
            isDone = true;
            if (timer) clearTimeout(timer);
            player.removeEventListener('seeked', onSeeked);
            resolve();
        };

        const onSeeked = () => {
            if ('requestVideoFrameCallback' in player) {
                try {
                    player.requestVideoFrameCallback(() => done());
                    return;
                } catch (e) {}
            }
            requestAnimationFrame(() => done());
        };

        timer = setTimeout(done, 250); // 안전 타임아웃
        player.addEventListener('seeked', onSeeked, { once: true });
        
        try {
            player.currentTime = targetTime;
        } catch (e) {
            done();
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

    STATE.isRendering = true;

    // 브라우저가 지원하는 비디오 인코딩 포맷 탐색 (MP4 지원 브라우저 우선, 미지원 시 WebM)
    let mimeType = 'video/webm; codecs=vp9';
    let fileExt = 'webm';

    if (MediaRecorder.isTypeSupported('video/mp4; codecs=avc1.42E01E,mp4a.40.2')) {
        mimeType = 'video/mp4; codecs=avc1.42E01E,mp4a.40.2';
        fileExt = 'mp4';
    } else if (MediaRecorder.isTypeSupported('video/mp4; codecs=avc1')) {
        mimeType = 'video/mp4; codecs=avc1';
        fileExt = 'mp4';
    } else if (MediaRecorder.isTypeSupported('video/mp4')) {
        mimeType = 'video/mp4';
        fileExt = 'mp4';
    } else if (MediaRecorder.isTypeSupported('video/webm; codecs=vp9,opus')) {
        mimeType = 'video/webm; codecs=vp9,opus';
        fileExt = 'webm';
    } else if (MediaRecorder.isTypeSupported('video/webm; codecs=vp9')) {
        mimeType = 'video/webm; codecs=vp9';
        fileExt = 'webm';
    } else {
        mimeType = 'video/webm';
        fileExt = 'webm';
    }

    updateRenderModalUI({
        heading: "브라우저 즉시 렌더링 중...",
        desc: `브라우저 내장 인코더를 통해 ${fileExt.toUpperCase()} 포맷으로 영상을 생성하고 있습니다.`,
        engine: `브라우저 Canvas MediaRecorder (${fileExt.toUpperCase()})`,
        status: "rendering"
    });

    try {
        const renderCanvas = document.createElement('canvas');
        renderCanvas.width = STATE.outputWidth;
        renderCanvas.height = STATE.outputHeight;
        const rCtx = renderCanvas.getContext('2d');

        const fps = STATE.outputFps || 30;
        const stream = renderCanvas.captureStream(fps);

        const recorder = new MediaRecorder(stream, {
            mimeType: mimeType,
            videoBitsPerSecond: 12000000
        });

        const chunks = [];
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        const renderPromise = new Promise(resolve => {
            recorder.onstop = () => {
                STATE.isRendering = false;
                const blob = new Blob(chunks, { type: mimeType });
                const url = URL.createObjectURL(blob);
                const fileName = `LookVideo_${formatDateForFilename(new Date())}.${fileExt}`;

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
                    desc: `${fileExt.toUpperCase()} 영상이 생성되어 다운로드 폴더에 자동 저장되었습니다.`,
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
                STATE.isRendering = false;
                recorder.stop();
                return;
            }

            const currentTime = Math.min(totalDuration, i * frameInterval);

            // 1. 해당 시점의 활성 비디오 클립 플레이어들의 시간을 맞추고 비디오 프레임 디코딩 대기
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

            // 2. 렌더링 시점 설정 및 프리뷰 캔버스에 프레임 그리기
            STATE.playheadTime = currentTime;
            updatePlayheadPosition();
            updateTimeDisplay();
            renderPreview();

            // 3. 고해상도 렌더 캔버스에 복사
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

            // MediaRecorder 프레임 캡처 대기 (최소 25ms)
            await new Promise(r => setTimeout(r, 25));
        }

        await new Promise(r => setTimeout(r, 250));
        recorder.stop();
        await renderPromise;

    } catch (err) {
        STATE.isRendering = false;
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
    if (data.descHtml) {
        // 우리가 만든 안내 문구(강조 포함)만 HTML 로 넣는다. 오류 메시지 등 외부 문자열은
        // textContent 경로로만 다뤄 마크업이 해석되지 않게 한다.
        DOM.renderStatusDesc.innerHTML = data.descHtml;
    } else if (data.desc) {
        DOM.renderStatusDesc.textContent = data.desc;
    }
    
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

    if (data.metaRes) DOM.renderMetaRes.textContent = data.metaRes;
    else DOM.renderMetaRes.textContent = `${STATE.outputWidth} x ${STATE.outputHeight}`;

    if (data.status === 'completed') {
        DOM.renderSpinner.classList.add('hide');
        DOM.renderCompleteActions.classList.remove('hide');
        DOM.renderOutputFilename.textContent = data.outputFile || STATE.activeRenderOutput;

        DOM.btnCancelRender.classList.add('hide');
        DOM.btnRenderDone.classList.remove('hide');

        const videoEl = document.getElementById('rendered-result-video');
        const imageEl = DOM.renderedResultImage;

        if (data.isAnimatedImage) {
            // WebP 는 <video> 로 재생되지 않는다 — <img> 로 보여준다
            if (videoEl) {
                videoEl.pause();
                videoEl.removeAttribute('src');
                videoEl.classList.add('hide');
            }
            if (imageEl) {
                const cleanPath = (data.outputUrl || data.outputFile || STATE.activeRenderOutput || '').replace(/\\/g, '/');
                imageEl.src = (cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`) + `?t=${Date.now()}`;
                imageEl.classList.remove('hide');
            }
            if (data.metaRes) DOM.renderMetaRes.textContent = data.metaRes;
        } else if (videoEl) {
            if (imageEl) {
                imageEl.classList.add('hide');
                imageEl.removeAttribute('src');
            }
            videoEl.classList.remove('hide');
            if (data.isBrowserBlob) {
                videoEl.src = data.blobUrl;
            } else {
                const cleanPath = (data.outputUrl || data.outputFile || STATE.activeRenderOutput || '').replace(/\\/g, '/');
                videoEl.src = (cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`) + `?t=${Date.now()}`;
            }
            videoEl.load();
            videoEl.play().catch(() => {}); // 자동 재생 시도
        }

        // WebP 결과 요약 — 예측 가능성이 목표이므로 실제 수치를 그대로 노출한다
        if (DOM.webpResultSummary) {
            if (data.webpStats) {
                const s = data.webpStats;
                const mb = (n) => (n / 1048576).toFixed(2);
                const over = s.exceededTarget
                    ? ` <span class="webp-over-target">(목표 초과)</span>` : '';
                let summaryHtml =
                    `<span class="webp-stat-label">webP</span> ` +
                    `<span class="webp-stat-value">${s.duration.toFixed(1)}초 · ${s.width}x${s.height} · ` +
                    `q=${s.quality} · ${mb(s.sizeBytes)}MB</span>${over}<br>` +
                    `<span class="webp-stat-label">목표</span> ` +
                    `<span class="webp-stat-value">${mb(s.targetBytes)}MB 이하</span> · ` +
                    `<span class="webp-stat-label">시험 인코딩</span> ` +
                    `<span class="webp-stat-value">${s.probes}회</span>`;
                // GIF 동시 저장 결과 — 쇼핑몰 등록용이므로 실제 설정을 그대로 노출한다
                if (s.gif) {
                    const gOver = s.gif.exceededTarget
                        ? ` <span class="webp-over-target">(목표 초과)</span>` : '';
                    // 재생 길이를 줄였으면 실제로 몇 초짜리인지, 원래 구간이 몇 초였는지 함께 보여준다
                    const gDur = s.gif.duration > 0
                        ? `${s.gif.duration.toFixed(1)}초` : s.gif.rangeDuration.toFixed(1) + '초';
                    const gTrim = s.gif.duration > 0 && s.gif.duration < s.gif.rangeDuration
                        ? ` <span class="webp-stat-note">(구간 ${s.gif.rangeDuration.toFixed(1)}초 중)</span>` : '';
                    summaryHtml +=
                        `<br><span class="webp-stat-label">GIF</span> ` +
                        `<span class="webp-stat-value">${gDur} · ${s.gif.fps}fps · ${s.gif.width}x${s.gif.height} · ` +
                        `${s.gif.colors}색 · ${mb(s.gif.sizeBytes)}MB</span>${gOver}${gTrim}<br>` +
                        `<span class="webp-stat-label">GIF 목표</span> ` +
                        `<span class="webp-stat-value">${mb(s.gif.targetBytes)}MB 이하</span>`;
                }
                DOM.webpResultSummary.innerHTML = summaryHtml;
                DOM.webpResultSummary.classList.remove('hide');
            } else {
                DOM.webpResultSummary.classList.add('hide');
                DOM.webpResultSummary.innerHTML = '';
            }
        }

        // 렌더 완료 후 릴스 목록 갱신 (선택 폴더 reels에 저장된 새 결과물 반영)
        // WebP 는 영상 목록에 넣지 않으므로 건너뛴다.
        if (!data.isAnimatedImage) loadReels();

        if (data.isBrowserBlob) {
            DOM.btnDownloadRenderedVideo.classList.remove('hide');
            DOM.btnDownloadRenderedVideo.innerHTML = `<i class="fa-solid fa-download"></i> 비디오 다운로드`;
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
            DOM.btnDownloadRenderedVideo.classList.remove('hide');
            // 애니메이션 결과는 같은 버튼을 쓰므로 라벨을 결과 종류에 맞춘다 (GIF 버튼과 짝)
            DOM.btnDownloadRenderedVideo.innerHTML =
                `<i class="fa-solid fa-download"></i> ${data.isAnimatedImage ? 'webP 다운로드' : '비디오 다운로드'}`;
            DOM.btnDownloadRenderedVideo.onclick = () => {
                const a = document.createElement('a');
                const cleanPath = (data.outputUrl || data.outputFile || STATE.activeRenderOutput || '').replace(/\\/g, '/');
                a.href = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
                a.download = (data.outputFile || 'rendered_video.mp4').split(/[\\\/]/).pop();
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            };
        }

        // GIF 동시 저장 결과 다운로드 버튼
        if (DOM.btnDownloadRenderedGif) {
            const gifFile = data.gifFile || STATE.activeRenderGif || null;
            if (gifFile) {
                DOM.btnDownloadRenderedGif.classList.remove('hide');
                DOM.btnDownloadRenderedGif.onclick = () => {
                    const a = document.createElement('a');
                    const cleanPath = (data.gifUrl || gifFile).replace(/\\/g, '/');
                    a.href = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
                    a.download = String(gifFile).split(/[\\\/]/).pop();
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                };
            } else {
                DOM.btnDownloadRenderedGif.classList.add('hide');
            }
        }
    } else if (data.status === 'needs_confirm') {
        // 확인 UI 는 pollRenderProgress 가 띄운다. 여기서는 스피너만 멈춘다.
        DOM.renderSpinner.classList.add('hide');
        DOM.btnCancelRender.classList.add('hide');
        if (data.descHtml && DOM.webpConfirmDesc) DOM.webpConfirmDesc.innerHTML = data.descHtml;
    } else if (data.status === 'error' || data.status === 'cancelled') {
        DOM.renderSpinner.classList.add('hide');
        DOM.btnCancelRender.classList.add('hide');
        DOM.btnRenderDone.classList.remove('hide');
        if (DOM.webpConfirmBox) DOM.webpConfirmBox.classList.add('hide');
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

    // WebP 전용 요소 초기화
    if (DOM.webpConfirmBox) DOM.webpConfirmBox.classList.add('hide');
    if (DOM.webpResultSummary) {
        DOM.webpResultSummary.classList.add('hide');
        DOM.webpResultSummary.innerHTML = '';
    }
    if (DOM.renderedResultImage) {
        DOM.renderedResultImage.classList.add('hide');
        DOM.renderedResultImage.removeAttribute('src');
    }
    if (DOM.btnDownloadRenderedGif) {
        DOM.btnDownloadRenderedGif.classList.add('hide');
        DOM.btnDownloadRenderedGif.onclick = null;
    }
    const videoEl = document.getElementById('rendered-result-video');
    if (videoEl) {
        videoEl.classList.remove('hide');
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
    }
}

function closeRenderModal() {
    const videoEl = document.getElementById('rendered-result-video');
    if (videoEl) {
        videoEl.pause();
    }
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

/* ========================================================================
   애니메이션 WebP 내보내기
   ======================================================================== */

function updateWebpModalReadout() {
    const range = clampWebpRange();
    const end = range.start + range.duration;

    if (DOM.webpRangeReadout) {
        DOM.webpRangeReadout.textContent = `${range.start.toFixed(1)}초 ~ ${end.toFixed(1)}초`;
    }
    if (DOM.webpRangeDuration) {
        // 프레임 수를 함께 보여주면 용량 예산 감각이 생긴다 (5초×20fps = 100프레임이 한도)
        const fps = parseInt(DOM.webpFps?.value, 10) || STATE.webpFps;
        const frames = Math.max(1, Math.round(range.duration * fps));
        DOM.webpRangeDuration.textContent = `${range.duration.toFixed(1)}초 · ${frames}프레임`;
    }
    // 구간이 바뀌면 고를 수 있는 GIF 재생 길이도 달라진다
    updateGifDurationOptions();
}

/**
 * GIF 재생 길이 옵션을 현재 선택 구간에 맞춘다.
 * 구간보다 긴 길이는 고를 수 없으므로 비활성화하고, 실효 길이를 함께 보여준다.
 */
function updateGifDurationOptions() {
    if (!DOM.webpGifDuration) return;
    const rangeDur = clampWebpRange().duration;

    // 구간보다 긴 항목은 선택 불가
    let selectionDisabled = false;
    for (const opt of DOM.webpGifDuration.options) {
        const val = parseFloat(opt.value) || 0;
        const tooLong = val > 0 && val > rangeDur + 0.05;
        opt.disabled = tooLong;
        if (tooLong && opt.selected) selectionDisabled = true;
    }
    if (selectionDisabled) {
        STATE.gifDuration = 0;
        DOM.webpGifDuration.value = '0';
    }
    DOM.webpGifDuration.value = String(STATE.gifDuration);

    const effDur = STATE.gifDuration > 0 ? Math.min(STATE.gifDuration, rangeDur) : rangeDur;
    if (DOM.webpGifDurationValue) {
        DOM.webpGifDurationValue.textContent = `${effDur.toFixed(1)}초`;
    }
}

/** GIF 옵션 영역 표시/숨김 (체크박스 상태 반영) */
function updateGifOptionsUI() {
    if (DOM.webpGifOptions) {
        DOM.webpGifOptions.classList.toggle('disabled', !STATE.gifEnabled);
    }
    if (DOM.webpGifTargetSize) DOM.webpGifTargetSize.disabled = !STATE.gifEnabled;
    if (DOM.webpGifDuration) DOM.webpGifDuration.disabled = !STATE.gifEnabled;
    if (DOM.webpNoteGif) DOM.webpNoteGif.style.display = STATE.gifEnabled ? '' : 'none';
    updateGifDurationOptions();
}

function openWebpModal() {
    if (STATE.clips.filter(c => c.track === 'video1').length === 0) {
        alert("메인 비디오 트랙(Video Track 1)에 최소 하나 이상의 비디오 클립이 있어야 합니다.");
        return;
    }

    clampWebpRange();

    DOM.webpTargetSize.value = STATE.webpTargetMB;
    DOM.webpTargetValue.textContent = `${STATE.webpTargetMB.toFixed(1)} MB`;
    DOM.webpFps.value = String(STATE.webpFps);
    if (DOM.webpGifEnabled) DOM.webpGifEnabled.checked = !!STATE.gifEnabled;
    if (DOM.webpGifTargetSize) DOM.webpGifTargetSize.value = String(STATE.gifTargetMB);
    if (DOM.webpGifTargetValue) DOM.webpGifTargetValue.textContent = `${STATE.gifTargetMB.toFixed(1)} MB`;
    if (DOM.webpGifDuration) DOM.webpGifDuration.value = String(STATE.gifDuration);
    updateGifOptionsUI();
    updateWebpModalReadout();

    DOM.webpModal.classList.remove('hide');
    DOM.webpModal.classList.add('show');
}

function closeWebpModal() {
    DOM.webpModal.classList.remove('show');
    setTimeout(() => DOM.webpModal.classList.add('hide'), 250);
}

// 설정 모달의 값으로 내보내기를 시작한다.
async function startWebpExportFromModal() {
    clampWebpRange();
    const range = STATE.webpRange;
    const targetMB = parseFloat(DOM.webpTargetSize.value) || STATE.webpTargetMB;
    const fps = parseInt(DOM.webpFps.value, 10) || STATE.webpFps;
    // GIF 재생 길이: 0 = 선택 구간 전체. 구간보다 길 수는 없다.
    const gifDuration = STATE.gifDuration > 0
        ? Math.min(STATE.gifDuration, range.duration)
        : 0;

    STATE.webpTargetMB = targetMB;
    STATE.webpFps = fps;

    closeWebpModal();

    // 소스 파일을 서버로 동기화한 뒤 최신 localPath 로 파라미터를 만든다
    openRenderModal();
    updateRenderModalUI({
        heading: "WebP 내보내기 준비 중...",
        desc: "소스 미디어를 동기화하고 인코딩 파라미터를 구성하고 있습니다.",
        progress: 0,
        status: "preparing"
    });

    try {
        await ensureAssetsUploadedToLocalServer();

        const renderParams = generateFFmpegCommand({
            ...STATE,
            reelsFolder: currentReelsFolder
        });
        if (renderParams.error) throw new Error(renderParams.error);

        const outputFile = buildWebpOutputPath();

        const res = await fetch('/api/render/webp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rawInputs: renderParams.rawInputs,
                filterComplex: renderParams.filterComplex,
                mappedVideo: renderParams.mappedVideo,
                mappedAudio: renderParams.mappedAudio,
                rangeStart: range.start,
                rangeDuration: range.duration,
                fps,
                targetMB,
                outputWidth: STATE.outputWidth,
                outputHeight: STATE.outputHeight,
                outputFile,
                gifEnabled: !!STATE.gifEnabled,
                gifTargetMB: STATE.gifTargetMB,
                gifDuration
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'WebP 내보내기 시작이 거부되었습니다.');

        STATE.activeRenderOutput = outputFile;
        STATE.activeRenderGif = null;
        STATE.webpConfirmTarget = 'webp';

        updateRenderModalUI({
            heading: "애니메이션 WebP 인코딩 중...",
            desc: STATE.gifEnabled
                ? `목표 용량에 맞춰 품질을 탐색하고 있습니다. 완료 후 GIF(목표 ${STATE.gifTargetMB.toFixed(1)}MB${gifDuration > 0 ? `, ${gifDuration.toFixed(1)}초 재생` : ''})도 이어서 생성합니다.`
                : "목표 용량에 맞춰 품질을 탐색하고 있습니다.",
            engine: STATE.gifEnabled ? "로컬 FFmpeg (WebP 품질 탐색 + GIF 동시 저장)" : "로컬 FFmpeg (WebP 품질 탐색)",
            status: "rendering"
        });

        if (STATE.renderPollingTimer) clearInterval(STATE.renderPollingTimer);
        STATE.renderPollingTimer = setInterval(pollRenderProgress, 400);
    } catch (err) {
        console.error('WebP 내보내기 시작 실패:', err);
        updateRenderModalUI({
            heading: "WebP 내보내기 시작 실패",
            desc: err.message,
            status: "error"
        });
    }
}

// WebP 결과물 경로 (릴스 폴더가 선택되어 있으면 그 안에 저장)
function buildWebpOutputPath() {
    const stamp = formatDateForFilename(new Date());
    const reelsFolder = String(currentReelsFolder || '');
    const safeFolder = /^[\w가-힣\-_]+$/.test(reelsFolder) ? reelsFolder : '';
    return safeFolder
        ? `..\\samples\\${safeFolder}\\reels\\webp_${stamp}.webp`
        : `output\\webp_${stamp}.webp`;
}

// 해상도 하향 확인 응답 (accept=true 면 낮춰서 진행, false 면 현재 화질로 저장)
async function confirmWebpDownscale(accept) {
    if (DOM.webpConfirmBox) DOM.webpConfirmBox.classList.add('hide');

    if (STATE.renderPollingTimer) clearInterval(STATE.renderPollingTimer);

    try {
        const suggestion = STATE.webpSuggestion || {};
        const isGif = STATE.webpConfirmTarget === 'gif';
        // GIF 확인: accept = "가장 낮은 설정으로 저장"(floor), 거부 = "GIF 건너뛰기"(skip)
        // webP 확인: accept = 해상도 하향, 거부 = 현재 화질로 저장(floor)
        const payload = isGif
            ? { action: accept ? 'floor' : 'skip', target: 'gif' }
            : (accept
                ? { action: 'downscale', width: suggestion.width, height: suggestion.height }
                : { action: 'floor' });

        const res = await fetch('/api/render/webp/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '요청이 거부되었습니다.');

        if (isGif && !accept) {
            // 건너뛰기는 서버가 바로 완료 처리한다 — 폴링 없이 결과를 반영한다
            updateRenderModalUI({
                heading: "GIF를 건너뛰었습니다",
                desc: "webP 결과만 저장되었습니다. (쿠팡은 webP만 사용하므로 문제 없습니다)",
                status: "completed"
            });
            return;
        }

        updateRenderModalUI({
            heading: isGif
                ? "가장 낮은 설정으로 GIF를 저장하는 중..."
                : (accept ? "낮춘 해상도로 다시 인코딩 중..." : "현재 화질로 저장 중..."),
            desc: isGif
                ? "GIF를 확정 인코딩하고 있습니다 (목표를 넘을 수 있습니다)."
                : (accept
                    ? `${suggestion.width}x${suggestion.height} 기준으로 품질을 다시 탐색합니다.`
                    : "품질 하한으로 전체 프레임을 인코딩하고 있습니다."),
            status: "rendering"
        });

        STATE.renderPollingTimer = setInterval(pollRenderProgress, 400);
    } catch (err) {
        updateRenderModalUI({
            heading: "진행할 수 없습니다",
            desc: err.message,
            status: "error"
        });
    }
}

async function openRenderedVideoFile() {
    // 1. 웹 브라우저 인앱 비디오 플레이어로 즉시 재생 및 전체화면 지원
    const videoEl = document.getElementById('rendered-result-video');
    if (videoEl) {
        try {
            videoEl.play();
            if (videoEl.requestFullscreen) {
                videoEl.requestFullscreen().catch(() => {});
            }
        } catch (e) {}
    }

    // 2. PC 로컬 비디오 플레이어 실행 요청
    try {
        const res = await fetch('/api/open-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outputFile: STATE.activeRenderOutput })
        });
        if (!res.ok) {
            const cleanPath = (STATE.activeRenderOutput || 'output/rendered_video.mp4').replace(/\\/g, '/');
            const fileUrl = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
            window.open(fileUrl, '_blank');
        }
    } catch (e) {
        console.error("Open file error:", e);
    }
}

async function openOutputFolder() {
    try {
        const res = await fetch('/api/open-output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outputFile: STATE.activeRenderOutput })
        });
        if (res.ok) {
            const data = await res.json();
            console.log("[LookVideoEditor] 탐색기 열기 완료:", data.path);
        }
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

        // WebP 내보내기 설정도 초기화
        STATE.webpRange = { start: 0, duration: WEBP_MAX_DURATION };
        STATE.webpTargetMB = 3;
        STATE.webpFps = 20;
        STATE.gifEnabled = true;
        STATE.gifTargetMB = 5;
        STATE.gifDuration = 0;
        STATE.isWebpEditMode = false;
        updateWebpEditModeUI();
        updateGifOptionsUI();

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
        localPath: a.localPath,
        url: a.url || null   // 릴스 API URL — 서버 모드에서 로드 직후 프리뷰 자동 복구용
    }));

    const projectData = {
        version: "LookVideoEditor-v2.0",
        assets: cleanAssets,
        clips: STATE.clips,
        totalDuration: STATE.totalDuration,
        outputWidth: STATE.outputWidth,
        outputHeight: STATE.outputHeight,
        outputFps: STATE.outputFps,
        encoder: STATE.encoder,
        reelsFolder: currentReelsFolder,  // 릴스 불러오기에서 선택한 의류 폴더
        // 애니메이션 WebP 내보내기 설정
        webpRange: { start: STATE.webpRange.start, duration: STATE.webpRange.duration },
        webpTargetMB: STATE.webpTargetMB,
        webpFps: STATE.webpFps,
        // GIF 동시 저장 설정
        gifEnabled: STATE.gifEnabled,
        gifTargetMB: STATE.gifTargetMB,
        gifDuration: STATE.gifDuration
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

            // 기존 미디어 플레이어 정리 후 교체
            DOM.hiddenPlayersContainer.innerHTML = '';
            Object.keys(activePlayers).forEach(k => delete activePlayers[k]);

            STATE.clips = data.clips.map(c => ({
                ...c,
                speed: c.speed || 1.0
            }));
            STATE.totalDuration = data.totalDuration || 30;
            STATE.outputWidth = data.outputWidth || 1920;
            STATE.outputHeight = data.outputHeight || 1080;
            STATE.outputFps = data.outputFps || 30;
            STATE.encoder = data.encoder || 'h264_nvenc';

            // WebP 설정 복원 (저장값이 없던 프로젝트도 안전하게 기본값으로)
            const savedRange = data.webpRange || {};
            STATE.webpRange = {
                start: Number.isFinite(savedRange.start) ? savedRange.start : 0,
                duration: Number.isFinite(savedRange.duration)
                    ? Math.min(savedRange.duration, WEBP_MAX_DURATION)
                    : WEBP_MAX_DURATION
            };
            STATE.webpTargetMB = Number.isFinite(data.webpTargetMB)
                ? Math.min(7, Math.max(2, data.webpTargetMB)) : 3;
            STATE.webpFps = Number.isFinite(data.webpFps) ? data.webpFps : 20;
            // GIF 동시 저장 설정 (없던 프로젝트는 기본값 — 켜짐 / 5MB)
            STATE.gifEnabled = typeof data.gifEnabled === 'boolean' ? data.gifEnabled : true;
            STATE.gifTargetMB = Number.isFinite(data.gifTargetMB)
                ? Math.min(10, Math.max(2, data.gifTargetMB)) : 5;
            // 재생 길이 0 = 선택 구간 전체. 구간보다 길면 구간 길이로 깎는다.
            // 드롭다운에 없는 값이 저장돼 있으면 UI 와 어긋나므로 가장 가까운 항목으로 맞춘다.
            const savedGifDuration = Number.isFinite(data.gifDuration)
                ? Math.min(data.gifDuration, STATE.webpRange.duration) : 0;
            STATE.gifDuration = GIF_DURATION_CHOICES.find(v => v <= savedGifDuration + 0.001) || 0;
            STATE.isWebpEditMode = false;
            updateWebpEditModeUI();
            updateGifOptionsUI();

            if (DOM.projectResolution) {
                DOM.projectResolution.value = `${STATE.outputWidth}x${STATE.outputHeight}`;
            }
            if (DOM.projectFps) {
                DOM.projectFps.value = STATE.outputFps;
            }
            if (DOM.projectEncoder) {
                DOM.projectEncoder.value = STATE.encoder;
            }

            // 릴스 불러오기의 의류 폴더 선택 복원
            currentReelsFolder = data.reelsFolder || '';
            renderReelsFolderSelect();
            renderReelsGrid();

            STATE.assets = data.assets.map(a => ({
                ...a,
                url: a.url || null,   // 릴스 API URL 유지 → 서버 실행 중이면 프리뷰 자동 복구
                file: null
            }));

            // URL이 있는 에셋은 숨김 플레이어 자동 재생성 (프리뷰 즉시 복구)
            STATE.assets.forEach(asset => {
                if (asset.url) createHiddenPlayerForAsset(asset);
            });

            updatePreviewResolution();
            STATE.selectedClipId = null;
            selectClip(null);
            updateAssetListUI();
            updateTimelineClipsUI();
            recalculateTotalDuration();
            renderPreview();

            // 프리뷰 URL이 없는 에셋이 있을 때만 재연결 안내
            const needsReconnect = STATE.assets.some(a => (a.type === 'video' || a.type === 'audio') && !a.url);
            if (needsReconnect) showMediaReconnectModal();
            
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
                <p style="margin-top: 8px;">일부 미디어의 미리보기가 비활성화되어 있습니다. <strong>릴스 불러오기에서 해당 영상을 다시 추가</strong>하거나 이미지/음악 파일을 다시 선택해 주세요.</p>
                <div class="highlight-group" style="margin-top: 12px;">
                    <i class="fa-solid fa-circle-info"></i> 로컬 FFmpeg 렌더링 경로와 편집했던 타임라인 클립 정보는 그대로 유지됩니다.
                </div>
            </div>
            <div class="modal-footer">
                <button id="modal-btn-cancel" class="btn btn-secondary">나중에</button>
                <button id="modal-btn-select" class="btn btn-primary"><i class="fa-solid fa-file-audio"></i> 이미지/음악 파일 선택</button>
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

// ─────────────────────────────────────────────────────────────
// 오디오 클립 반복 재생
// ─────────────────────────────────────────────────────────────

/**
 * 오디오 클립의 반복 재생을 켜고 끈다.
 * 켜면 시작 위치를 0으로 고정하고(렌더러가 -ss 없이 파일 처음부터 읽는다),
 * 클립 길이를 영상 끝까지 늘려 음악이 짧아도 채워지게 한다.
 */
function setClipLoop(clip, enabled) {
    clip.loop = (enabled === true);
    if (clip.loop) {
        clip.sourceStart = 0;
        const asset = STATE.assets.find(a => a.id === clip.assetId);
        const sourceDur = (asset && asset.duration > 0) ? asset.duration
            : (clip.sourceEnd > 0 ? clip.sourceEnd : clip.duration);
        clip.sourceEnd = parseFloat(sourceDur.toFixed(2));

        // 자기 자신을 제외한 나머지 콘텐츠가 끝나는 지점까지 늘린다
        let othersEnd = 0;
        STATE.clips.forEach(c => {
            if (c.id === clip.id) return;
            const end = c.timelineStart + c.duration;
            if (end > othersEnd) othersEnd = end;
        });
        if (othersEnd > clip.timelineStart + 0.1) {
            clip.duration = parseFloat((othersEnd - clip.timelineStart).toFixed(2));
        }
    } else {
        clip.duration = parseFloat(Math.min(clip.sourceEnd || clip.duration, clip.duration).toFixed(2));
    }
}

// ─────────────────────────────────────────────────────────────
// 무료 음악 검색 (Openverse CC0 / 퍼블릭 도메인)
// ─────────────────────────────────────────────────────────────
const musicState = {
    lastQuery: '',
    results: [],
    previewAudio: null,     // activePlayers 에 넣지 않는다 (타임라인 동기화가 미리듣기를 멈춘다)
    previewId: null,
    busy: false,
    serverReady: true,      // 서버가 음악 API 를 지원하는지 (옛 코드로 떠 있으면 false)
};

function openMusicSearchModal() {
    if (!DOM.musicSearchModal) return;
    DOM.musicSearchModal.classList.remove('hide');
    DOM.musicSearchModal.classList.add('show');
    // 서버가 살아 있는지만으로는 부족하다 — 프로세스가 옛 코드로 떠 있으면 /api/music/* 가 404 다.
    // loadMusicKeywords 가 keywords 호출로 두 가지를 한 번에 확인한다.
    checkServerHealth().then(ok => {
        if (!ok) {
            setMusicServerReady(false, '로컬 서버가 실행 중일 때만 음악 검색을 사용할 수 있습니다. (이미지/음악 버튼으로 직접 추가는 가능합니다)');
            return;
        }
        loadMusicKeywords();
    });
    if (DOM.musicSearchInput) DOM.musicSearchInput.focus();
}

function closeMusicSearchModal() {
    stopMusicPreview();
    if (!DOM.musicSearchModal) return;
    DOM.musicSearchModal.classList.remove('show');
    setTimeout(() => DOM.musicSearchModal && DOM.musicSearchModal.classList.add('hide'), 250);
}

/**
 * 음악 API 사용 가능 여부에 따라 경고와 입력 잠금을 갱신한다.
 * @param {boolean} ready
 * @param {string} [message] 준비되지 않았을 때 보여줄 안내 (생략하면 기존 문구 유지)
 */
function setMusicServerReady(ready, message) {
    musicState.serverReady = ready;
    if (DOM.musicServerWarning) {
        if (message) {
            const span = DOM.musicServerWarning.querySelector('span');
            if (span) span.textContent = message;
        }
        DOM.musicServerWarning.classList.toggle('hide', ready);
    }
    if (DOM.btnMusicSearchRun) DOM.btnMusicSearchRun.disabled = !ready;
    if (DOM.musicSearchInput) DOM.musicSearchInput.disabled = !ready;
    if (!ready && message) setMusicStatus(message, 'error');
}

async function loadMusicKeywords() {
    if (!DOM.musicKeywordChips) return;
    try {
        const res = await fetch('/api/music/keywords', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        DOM.musicKeywordChips.innerHTML = '';
        (data.keywords || []).forEach(kw => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'music-chip';
            chip.textContent = `${kw.ko} (${kw.en})`;
            chip.addEventListener('click', () => {
                if (DOM.musicSearchInput) DOM.musicSearchInput.value = kw.en;
                runMusicSearch();
            });
            DOM.musicKeywordChips.appendChild(chip);
        });
        DOM.musicKeywordChips.dataset.loaded = '1';
        setMusicServerReady(true);
    } catch (e) {
        // 서버는 살아 있어도 옛 코드로 실행 중이면 이 API 가 없다 (재시작 필요)
        setMusicServerReady(false, '로컬 서버가 예전 코드로 실행 중입니다. LookVideoEditor 서버(8090)를 재시작한 뒤 브라우저를 새로고침해 주세요.');
    }
}

function setMusicStatus(message, kind = '') {
    if (!DOM.musicStatus) return;
    DOM.musicStatus.textContent = message || '';
    DOM.musicStatus.className = 'music-status' + (kind ? ' ' + kind : '');
}

async function runMusicSearch() {
    if (musicState.busy) return;
    const query = DOM.musicSearchInput ? DOM.musicSearchInput.value.trim() : '';
    if (!query) {
        setMusicStatus('검색어를 입력해 주세요.', 'error');
        return;
    }

    stopMusicPreview();
    musicState.busy = true;
    musicState.lastQuery = query;
    setMusicStatus('검색 중…');
    if (DOM.btnMusicSearchRun) DOM.btnMusicSearchRun.disabled = true;

    try {
        const selected = DOM.musicFilterDuration ? DOM.musicFilterDuration.value : '';
        const params = new URLSearchParams({ q: query });
        if (selected) {
            const [min, max] = selected.split('-');
            params.set('min_duration', min);
            params.set('max_duration', max);
        }

        const res = await fetch(`/api/music/search?${params.toString()}`, { cache: 'no-store' });
        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { data = null; }

        if (!data) {
            // JSON 이 아니면 이 API 를 모르는 서버(옛 코드로 실행 중)이거나 응답이 깨진 경우다
            musicState.results = [];
            renderMusicResults();
            if (res.status === 404) {
                setMusicServerReady(false, '로컬 서버가 예전 코드로 실행 중입니다. LookVideoEditor 서버(8090)를 재시작한 뒤 브라우저를 새로고침해 주세요.');
            } else {
                setMusicStatus(`검색에 실패했습니다. (HTTP ${res.status})`, 'error');
            }
            return;
        }

        if (!res.ok || data.success === false) {
            musicState.results = [];
            renderMusicResults();
            setMusicStatus(data.message || `검색에 실패했습니다. (${res.status})`, 'error');
            return;
        }

        musicState.results = data.results || [];
        renderMusicResults();

        // 변환 힌트
        if (DOM.musicTranslateHint) {
            const q = data.query || {};
            if (q.wasTranslated && q.translated) {
                DOM.musicTranslateHint.innerHTML = `검색어 변환: <strong>${escapeHtml(q.original)}</strong> → <strong>${escapeHtml(q.translated)}</strong>`;
                DOM.musicTranslateHint.classList.remove('hide');
            } else if (q.failed) {
                DOM.musicTranslateHint.innerHTML = `한국어 검색어를 영어로 바꾸지 못했습니다. <strong>calm, lofi, piano</strong> 처럼 영어로 입력해 보세요.`;
                DOM.musicTranslateHint.classList.remove('hide');
            } else {
                DOM.musicTranslateHint.classList.add('hide');
            }
        }

        if (DOM.musicResultCount) {
            const rl = data.rateLimit || {};
            const remain = (rl.dailyRemaining !== undefined && rl.dailyRemaining !== null)
                ? ` · 오늘 남은 검색 ${rl.dailyRemaining}회` : '';
            DOM.musicResultCount.textContent = `결과 ${musicState.results.length}건 / 전체 ${data.resultCount || 0}건${remain}`;
        }
        setMusicStatus(musicState.results.length === 0
            ? '검색 결과가 없습니다. 다른 키워드로 시도해 보세요.'
            : '▶ 를 눌러 들어본 뒤 [트랙에 추가] 하세요. 모두 CC0/퍼블릭 도메인이라 출처 표시 의무가 없습니다.');
    } catch (e) {
        musicState.results = [];
        renderMusicResults();
        setMusicStatus('검색 중 오류가 발생했습니다. 로컬 서버와 인터넷 연결을 확인해 주세요.', 'error');
    } finally {
        musicState.busy = false;
        // 서버가 옛 코드면 다시 잠가둔 상태를 유지한다 (여기서 무조건 풀면 안 된다)
        if (DOM.btnMusicSearchRun) DOM.btnMusicSearchRun.disabled = !musicState.serverReady;
    }
}

function renderMusicResults() {
    if (!DOM.musicResultList) return;
    DOM.musicResultList.innerHTML = '';

    if (musicState.results.length === 0) {
        DOM.musicResultList.innerHTML = '<li class="empty-list-msg">표시할 결과가 없습니다.</li>';
        return;
    }

    musicState.results.forEach(item => {
        const li = document.createElement('li');
        li.className = 'music-result-item';
        li.dataset.musicId = item.id;

        const licenseLabel = item.license === 'pdm' ? 'Public Domain' : 'CC0 1.0';
        const sourceLink = item.landingUrl
            ? `<a href="${escapeHtml(item.landingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.provider || '원본')} ↗</a>`
            : '';
        const licenseLink = item.licenseUrl
            ? `<a href="${escapeHtml(item.licenseUrl)}" target="_blank" rel="noopener noreferrer">라이선스 ↗</a>`
            : '';

        li.innerHTML = `
            <button class="music-play-btn" type="button" title="들어보기"><i class="fa-solid fa-play"></i></button>
            <div class="music-info">
                <div class="music-title">${escapeHtml(item.title)}</div>
                <div class="music-meta">
                    <span>${escapeHtml(item.creator || '크리에이터 미상')}</span>
                    <span class="music-badge">${licenseLabel}</span>
                    <span>${escapeHtml(item.filetype.toUpperCase())}</span>
                    ${sourceLink}
                    ${licenseLink}
                </div>
            </div>
            <span class="music-duration">${formatTimeShort(item.durationSec)}</span>
            <button class="btn btn-sm btn-primary music-add-btn" type="button">
                <i class="fa-solid fa-plus"></i> 트랙에 추가
            </button>
        `;

        li.querySelector('.music-play-btn').addEventListener('click', () => toggleMusicPreview(item));
        li.querySelector('.music-add-btn').addEventListener('click', (e) => addMusicToTimeline(item, e.currentTarget));
        DOM.musicResultList.appendChild(li);
    });
}

function toggleMusicPreview(item) {
    if (musicState.previewId === item.id) {
        stopMusicPreview();
        return;
    }
    stopMusicPreview();
    if (!item.previewUrl) return;

    if (!musicState.previewAudio) {
        musicState.previewAudio = new Audio();
        musicState.previewAudio.preload = 'none';
        musicState.previewAudio.addEventListener('ended', () => {
            musicState.previewId = null;
            updateMusicPreviewUI();
        });
    }
    musicState.previewAudio.src = item.previewUrl;
    musicState.previewId = item.id;
    musicState.previewAudio.play().catch(() => {
        setMusicStatus('미리듣기를 재생할 수 없습니다. 트랙에 추가한 뒤 타임라인에서 들어보세요.', 'error');
        musicState.previewId = null;
        updateMusicPreviewUI();
    });
    updateMusicPreviewUI();
    setMusicStatus(`미리듣기: ${item.title}`);
}

function stopMusicPreview() {
    if (musicState.previewAudio) {
        try {
            musicState.previewAudio.pause();
            musicState.previewAudio.src = '';
        } catch (e) {}
    }
    if (musicState.previewId === null) return;
    musicState.previewId = null;
    updateMusicPreviewUI();
}

function updateMusicPreviewUI() {
    if (!DOM.musicResultList) return;
    DOM.musicResultList.querySelectorAll('.music-result-item').forEach(li => {
        const playing = li.dataset.musicId === musicState.previewId;
        li.classList.toggle('playing', playing);
        const icon = li.querySelector('.music-play-btn i');
        if (icon) icon.className = playing ? 'fa-solid fa-stop' : 'fa-solid fa-play';
    });
}

async function addMusicToTimeline(item, btn) {
    if (!btn || btn.disabled) return;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 받는 중…';
    setMusicStatus(`'${item.title}' 내려받는 중…`);

    try {
        const res = await fetch('/api/music/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id }),   // id 만 보낸다 (URL 은 서버가 재조회)
        });
        const data = await res.json();

        if (!res.ok || data.success === false) {
            setMusicStatus(data.message || '음악을 추가하지 못했습니다.', 'error');
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            return;
        }

        // 같은 파일이 이미 라이브러리에 있으면 재사용
        let asset = STATE.assets.find(a => a.localPath && data.localPath
            && a.localPath.toLowerCase() === data.localPath.toLowerCase());

        if (!asset) {
            asset = {
                id: 'asset_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                name: data.filename,
                type: 'audio',
                duration: data.durationSec || 5.0,
                url: data.url,
                file: null,               // file:null → 서버 업로드 자동 스킵
                localPath: data.localPath,
                musicMeta: {
                    title: data.title, creator: data.creator, license: data.license,
                    licenseUrl: data.licenseUrl, landingUrl: data.landingUrl,
                },
            };
            STATE.assets.push(asset);
        }

        createHiddenPlayerForAsset(asset);
        updateAssetListUI();

        // 오디오 레인의 빈 지점부터 배치
        const start = findFreeAudioStart();
        addAssetToTimeline(asset.id, 'audio', start);

        // 음악이 영상보다 짧으면 자동 반복
        const wantLoop = DOM.musicLoopIfShort ? DOM.musicLoopIfShort.checked : true;
        const clip = STATE.clips.find(c => c.id === STATE.selectedClipId);
        if (wantLoop && clip && clip.assetId === asset.id) {
            let othersEnd = 0;
            STATE.clips.forEach(c => {
                if (c.id === clip.id) return;
                const end = c.timelineStart + c.duration;
                if (end > othersEnd) othersEnd = end;
            });
            if (othersEnd > clip.timelineStart + 0.1) setClipLoop(clip, true);
        }

        updateTimelineClipsUI();
        recalculateTotalDuration();
        renderPreview();

        btn.innerHTML = '<i class="fa-solid fa-check"></i> 담김';
        setMusicStatus(`'${data.title}' 을(를) 오디오 트랙에 추가했습니다.${data.reused ? ' (이미 받아둔 파일 재사용)' : ''}`, 'success');
    } catch (e) {
        setMusicStatus('음악을 추가하지 못했습니다. 로컬 서버 상태를 확인해 주세요.', 'error');
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

/** 오디오 트랙에서 아직 쓰이지 않은 뒤쪽 지점을 찾는다 (클립 겹침 방지) */
function findFreeAudioStart() {
    let end = 0;
    STATE.clips.forEach(c => {
        if (c.track !== 'audio') return;
        const clipEnd = c.timelineStart + c.duration;
        if (clipEnd > end) end = clipEnd;
    });
    return parseFloat(end.toFixed(2));
}
