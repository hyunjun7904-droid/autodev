# MOVAN AutoDev 시작 스크립트(AutoDev standalone repo에서 MOVAN repo를 external target으로
# 실행). .env 값은 절대 읽거나 출력하지 않는다 — 존재 여부만 확인한다.
#
# Phase B Task B2 — 물리적 repository 분리 이후 AutoDev Root(이 스크립트가 있는 위치)와
# Target Project Root(MOVAN repo)가 더 이상 같은 repository 안에 중첩돼 있지 않으므로,
# AUTODEV_TARGET_PROJECT_ROOT/AUTODEV_STATE_PATH를 이 스크립트가 명시적으로 지정해야 한다
# (project-context.ts는 이 값이 없으면 기본값으로 AutoDev Root의 부모 디렉터리를 쓰는데,
# 그건 이제 MOVAN repo가 아니라 Desktop 자체이므로 반드시 override가 필요하다). 두 경로 모두
# 이 machine의 실제 MOVAN repo 위치를 가리키는 절대경로다 — 다른 환경에 옮길 때는 이 두 줄만
# 바꾸면 된다.
$env:AUTODEV_TARGET_PROJECT_ROOT = "C:\Users\hyunj\OneDrive\Desktop\claude 자동화"
$env:AUTODEV_STATE_PATH = "C:\Users\hyunj\OneDrive\Desktop\claude 자동화\.autodev\project-state.json"

Set-Location $PSScriptRoot

# headless/백그라운드 실행(콘솔 핸들이 없는 세션 — 예: 자동화 도구가 stdout만 리디렉션해
# 실행하는 경우)에서는 콘솔 창 제목을 갱신하려는 시도가 Win32 예외(SetConsoleWindowTitle,
# 실제 관측된 사례: 0xE9/233 "파이프가 끝났습니다")를 던질 수 있다. 이전에는 스크립트 전체에
# $ErrorActionPreference = "Stop"이 걸려 있어 이런 순전히 화면 표시용 실패조차 스크립트를
# 통째로 죽였고, 그 시점에 이미 node dist/autodev.js 본체는 정상 종료된 뒤였는데도 wrapper가
# 비정상 종료(killed처럼 보임)로 끝났다. 콘솔 핸들이 없으면 제목 설정을 안전하게 건너뛴다.
try {
    if ($Host.Name -eq "ConsoleHost") {
        $Host.UI.RawUI.WindowTitle = "MOVAN AutoDev"
    }
} catch {
    Write-Output "[start-autodev] 콘솔 창 제목 설정을 건너뜁니다(콘솔 핸들 없음 — headless 실행)."
}

$envPath = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envPath)) {
    Write-Output "[start-autodev] .env 파일이 없습니다. OPENAI_API_KEY 설정이 필요합니다."
    exit 1
}
Write-Output "[start-autodev] .env 존재 확인됨 (내용은 표시하지 않습니다)."

$env:AUTOMATION_DRY_RUN = "false"

Write-Output "[start-autodev] AutoDev를 시작합니다 (Ctrl+C로 안전 종료 가능)."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Output "[start-autodev] build 실패(exit $LASTEXITCODE) — AutoDev를 실행하지 않습니다."
    exit $LASTEXITCODE
}

node dist/run-movan.js
# node의 실제 종료 코드를 wrapper 자신의 종료 코드로 그대로 전달한다 — node가 정상 종료했는데
# (WAITING_HUMAN 등 정상적인 종료 포함, run-movan.ts는 그 경우 exitCode를 건드리지 않아 0이다)
# wrapper 쪽 부수적인 문제 때문에 바깥에서 killed/error로 보이는 일이 없도록 한다.
$autodevExitCode = $LASTEXITCODE

Write-Output "[start-autodev] 종료됨(exit $autodevExitCode)."
exit $autodevExitCode
