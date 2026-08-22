# AutoDev 범용 시작 스크립트(AutoDev standalone repo 자신의 시작점).
#
# AutoDev 범용화 Phase B Task B3 — 이 스크립트는 이제 어떤 프로젝트를 개발할지 전혀 모른다.
# 이전에는 MOVAN repo의 절대경로(AUTODEV_TARGET_PROJECT_ROOT/AUTODEV_STATE_PATH)를 이
# 스크립트가 직접 하드코딩했다 — 그래서 이 스크립트 자체가 "MOVAN 전용"이었다. 이제는
# -ProjectAdapter 파라미터(또는 미리 설정된 AUTODEV_PROJECT_ADAPTER 환경변수)로 project
# config(JSON 데이터 파일, Phase C Task C1부터 .js 등 executable 모듈은 거부됨)의 절대경로를
# 명시적으로 받아 dist/run.js에 그대로 전달할 뿐이다 — 지정하지 않으면 기본 프로젝트로
# 조용히 넘어가지 않고 즉시 실패한다.
#
# 특정 프로젝트를 실행하려면: 그 프로젝트 저장소가 소유한 wrapper 스크립트(예: 그
# 저장소의 .autodev/start-autodev.ps1)를 대신 실행하라 — 그 wrapper가 자신의
# .autodev/manifest.json 경로를 -ProjectAdapter로 지정해 이 스크립트를 호출하는 방식을
# 권장한다. 새 프로젝트를 붙이려면 그 프로젝트가 동일한 방식의 wrapper를 스스로 두면
# 된다 — 이 스크립트는 손댈 필요가 없다.
#
# .env 값은 절대 읽거나 출력하지 않는다 — 존재 여부만 확인한다.
param(
    [string]$ProjectAdapter = $env:AUTODEV_PROJECT_ADAPTER
)

if (-not $ProjectAdapter -or $ProjectAdapter.Trim() -eq "") {
    Write-Output "[start-autodev] project adapter가 지정되지 않았습니다 — -ProjectAdapter <path> 파라미터 또는 AUTODEV_PROJECT_ADAPTER 환경변수로 명시적으로 지정하세요(기본 프로젝트 없음)."
    exit 1
}

Set-Location $PSScriptRoot

# headless/백그라운드 실행(콘솔 핸들이 없는 세션 — 예: 자동화 도구가 stdout만 리디렉션해
# 실행하는 경우)에서는 콘솔 창 제목을 갱신하려는 시도가 Win32 예외(SetConsoleWindowTitle,
# 실제 관측된 사례: 0xE9/233 "파이프가 끝났습니다")를 던질 수 있다. 이전에는 스크립트 전체에
# $ErrorActionPreference = "Stop"이 걸려 있어 이런 순전히 화면 표시용 실패조차 스크립트를
# 통째로 죽였고, 그 시점에 이미 node dist/autodev.js 본체는 정상 종료된 뒤였는데도 wrapper가
# 비정상 종료(killed처럼 보임)로 끝났다. 콘솔 핸들이 없으면 제목 설정을 안전하게 건너뛴다.
try {
    if ($Host.Name -eq "ConsoleHost") {
        $Host.UI.RawUI.WindowTitle = "AutoDev"
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

# 2026-08-22 incident 이후 — runtime-origin.ts의 isProductionRuntime()은
# AUTOMATION_DRY_RUN="false"와 AUTODEV_PRODUCTION_RUNTIME="true" 둘 다 명시적으로 참일
# 때만 실제 파일 store/Telegram credential을 활성화한다(dual-gate). 이 wrapper가 real
# production 실행의 유일한 표준 launcher이므로 둘 다 여기서 함께 설정한다.
$env:AUTOMATION_DRY_RUN = "false"
$env:AUTODEV_PRODUCTION_RUNTIME = "true"

Write-Output "[start-autodev] AutoDev를 시작합니다(project adapter: $ProjectAdapter, Ctrl+C로 안전 종료 가능)."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Output "[start-autodev] build 실패(exit $LASTEXITCODE) — AutoDev를 실행하지 않습니다."
    exit $LASTEXITCODE
}

node dist/run.js --project $ProjectAdapter
# node의 실제 종료 코드를 wrapper 자신의 종료 코드로 그대로 전달한다 — node가 정상 종료했는데
# (WAITING_HUMAN 등 정상적인 종료 포함, run.ts는 그 경우 exitCode를 건드리지 않아 0이다)
# wrapper 쪽 부수적인 문제 때문에 바깥에서 killed/error로 보이는 일이 없도록 한다.
$autodevExitCode = $LASTEXITCODE

Write-Output "[start-autodev] 종료됨(exit $autodevExitCode)."
exit $autodevExitCode
