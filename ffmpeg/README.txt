========================================================================
sVidEditor - 로컬 FFmpeg 렌더러 설정 안내
========================================================================

이 비디오 에디터는 웹 브라우저에서 편집 설정을 완료한 후, 
실제 영상 인코딩(렌더링)을 로컬 컴퓨터에서 FFmpeg를 통해 처리합니다.
정상적인 렌더링 작업을 위해 아래 단계를 진행해 주세요.

[설치 및 배치 방법]
1. FFmpeg 공식 다운로드 페이지 또는 빌드 배포처에 접속합니다.
   - 추천 다운로드처 (Windows build): https://www.gyan.dev/ffmpeg/builds/
   - 'ffmpeg-release-essentials.zip' 버전을 다운로드합니다.

2. 다운로드한 ZIP 압축 파일 내의 'bin' 폴더에서 다음 두 파일을 추출합니다.
   - ffmpeg.exe
   - ffprobe.exe

3. 추출한 두 파일을 현재 폴더(D:\Study\WebPage\sVidEditor\ffmpeg\) 안에 넣어 줍니다.
   즉, 아래와 같은 경로 구조가 되어야 합니다.
   - D:\Study\WebPage\sVidEditor\ffmpeg\ffmpeg.exe
   - D:\Study\WebPage\sVidEditor\ffmpeg\ffprobe.exe

※ 참고: Windows 시스템 환경 변수(PATH)에 이미 ffmpeg가 설치되어 있는 경우, 
이 폴더에 파일을 따로 넣지 않더라도 생성된 'render.bat' 파일이 자동으로 감지하여 작동합니다.

========================================================================
