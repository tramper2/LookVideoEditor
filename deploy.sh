#!/bin/bash

# LookVideoEditor - GitHub Pages 배포 자동화 스크립트

echo "====================================================================="
echo " Starting LookVideoEditor GitHub Pages Deployment..."
echo "====================================================================="
echo ""

if ! command -v git &> /dev/null
then
    echo "[ERROR] git 명령어를 찾을 수 없습니다."
    exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)
if [ -z "$CURRENT_BRANCH" ]; then
    CURRENT_BRANCH="main"
fi

echo "[INFO] 현재 브랜치(${CURRENT_BRANCH})의 변경 사항을 커밋합니다..."
git add .
git commit -m "Deploy LookVideoEditor to GitHub Pages"

echo ""
echo "[INFO] gh-pages 브랜치로 강제 푸시를 진행합니다..."
git push -f git@github.com:tramper2/LookVideoEditor.git ${CURRENT_BRANCH}:gh-pages

if [ $? -eq 0 ]; then
    echo ""
    echo "====================================================================="
    echo " [SUCCESS] 배포가 성공적으로 완료되었습니다!"
    echo " URL: https://tramper2.github.io/LookVideoEditor/"
    echo "====================================================================="
else
    echo ""
    echo "====================================================================="
    echo " [ERROR] 배포 실패. Git 리모트 권한 및 네트워크 연결을 확인해주세요."
    echo "====================================================================="
    exit 1
fi
