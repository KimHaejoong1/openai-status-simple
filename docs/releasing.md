# Chrome 웹 스토어 자동 배포

기존 [OpenAI Status Reader](https://chromewebstore.google.com/detail/openai-status-reader/nfidmnbdgmlgnfapkdgckfhoneoogkkh)를 업데이트합니다. 새 스토어 항목을 만들지 않으므로 기존 확장 프로그램 ID와 설치 사용자가 유지됩니다. 공개 스토어에서 확인한 이전 버전은 1.0.1이며, 이번 코드 버전은 2.0.0입니다.

## 배포 흐름

1. 변경 사항을 `main`에 병합합니다. 일반 브랜치 push와 PR은 테스트와 ZIP 생성만 수행합니다.
2. `manifest.json`과 `package.json`의 버전을 일치시킵니다.
3. 그 커밋에 같은 버전의 `vX.Y.Z` 태그를 push합니다.
4. Actions가 버전 및 `main` 포함 여부를 확인하고, 테스트와 ZIP 생성을 진행합니다.
5. 기존 스토어 항목에 ZIP을 업로드하고 심사를 요청합니다.
6. Google 심사를 통과하면 기존 공개 범위 설정으로 게시됩니다.

`main` push만으로 배포되지는 않습니다. `PENDING_REVIEW`는 심사 접수 성공이며 게시 완료는 아닙니다. 이 워크플로는 심사를 생략하지 않습니다.

## 처음 한 번: Google 인증 연결

아래 설정은 **기존 확장 프로그램을 관리하는 Google 계정**으로 진행합니다. 구글 계정의 2단계 인증도 필요합니다. 상세 화면은 [Chrome 공식 API 설정 안내](https://developer.chrome.com/docs/webstore/using-api)를 참고하세요.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 기존 프로젝트를 선택하거나 배포용 프로젝트를 만듭니다.
2. API 라이브러리에서 **Chrome Web Store API**를 활성화합니다.
3. **Google Auth Platform / OAuth 동의 화면**에 앱 정보를 설정합니다. External 테스트 단계에서는 본인 계정을 테스트 사용자로 등록합니다.
4. OAuth 클라이언트를 **Web application** 유형으로 만들고 승인된 리디렉션 URI에 `https://developers.google.com/oauthplayground`를 추가합니다.
5. [OAuth Playground](https://developers.google.com/oauthplayground) 오른쪽 위 설정에서 **Use your own OAuth credentials**를 켜고 해당 Client ID와 Client Secret을 입력합니다.
6. OAuth scope로 `https://www.googleapis.com/auth/chromewebstore`를 입력하고 **Authorize APIs**를 누릅니다. 기존 스토어 항목 소유 계정으로 승인합니다.
7. **Exchange authorization code for tokens**를 눌러 Refresh token을 발급받습니다. 장기적으로 사용할 값은 Access token이 아니라 Refresh token입니다.
8. [Chrome 웹 스토어 개발자 대시보드](https://chrome.google.com/webstore/devconsole/)에서 **Publisher → Settings**의 Publisher ID를 확인합니다. 확장 프로그램 ID나 이메일과는 다른 값입니다.

장기 자동 배포에 사용할 OAuth 앱은 **In production** 상태로 전환하고 그 상태에서 Refresh token을 발급하세요. External 앱이 Testing 상태이면 이 scope의 Refresh token은 7일 후 만료될 수 있습니다. 이는 확장 프로그램의 스토어 게시 상태와 별개입니다. [Google 토큰 만료 안내](https://developers.google.com/identity/protocols/oauth2#expiration)

인증 값은 채팅이나 코드 파일에 붙여 넣지 말고 아래 GitHub Secrets 화면에 직접 저장합니다. `.env`와 배포 ZIP은 Git에서 제외됩니다.

## GitHub 설정

[레포 Settings → Secrets and variables → Actions](https://github.com/KimHaejoong1/openai-status-simple/settings/secrets/actions)를 엽니다.

**Secrets** 탭에서 Repository secret 3개를 만듭니다.

| 이름 | 값 |
| --- | --- |
| `CWS_CLIENT_ID` | 위에서 만든 OAuth Client ID |
| `CWS_CLIENT_SECRET` | 해당 OAuth Client Secret |
| `CWS_REFRESH_TOKEN` | 위에서 발급받은 Refresh token |

**Variables** 탭에서 Repository variable 1개를 만듭니다.

| 이름 | 값 |
| --- | --- |
| `CWS_PUBLISHER_ID` | 개발자 대시보드의 Publisher ID |

확장 프로그램 ID `nfidmnbdgmlgnfapkdgckfhoneoogkkh`는 `.github/chrome-web-store.json`에 이미 설정되어 있습니다.

워크플로 파일이 `main`에 반영되면 **Actions → Chrome Web Store → Run workflow → main**으로 실행하세요. 수동 실행은 인증 및 기존 항목 조회만 수행합니다. 결과가 `CONNECTION_VERIFIED`이면 연결이 확인된 것입니다. 이 단계에서는 ZIP을 업로드하거나 심사를 요청하지 않습니다.

## 첫 2.0.0 배포

먼저 스토어 대시보드에서 기존 항목의 설명, 스크린샷, 개인정보 공개 항목이 새 버전에 맞는지 확인합니다. 특히 이번 버전은 `https://status.openai.com/*` 호스트 권한을 추가하므로 권한 사용 이유를 작성해야 할 수 있습니다. 자동 배포는 패키지만 업데이트하며 이 메타데이터를 대신 작성하지 않습니다.

연결 확인과 `main` 병합을 마친 뒤 아래를 실행합니다.

```sh
git switch main
git pull --ff-only
git tag v2.0.0
git push origin v2.0.0
```

**태그 push가 실제 업로드 및 심사 요청을 시작합니다.** Google 승인 후 자동 게시됩니다. 다음 배포는 두 JSON의 버전을 예를 들어 2.0.1로 올리고 `v2.0.1` 태그를 사용합니다. 기존 태그를 덮어쓰지 마세요.

## 로컬 패키징

Node.js 22 이상 및 Python 3에서 다음 명령을 사용합니다. 설치할 외부 패키지는 없습니다.

```sh
npm run check
npm test
npm run release:validate
python scripts/package_extension.py
```

Linux에서는 `python3`도 사용할 수 있습니다. 결과는 `dist/openai-status-reader.zip`입니다. 루트에 `manifest.json`이 있는 ZIP이며, 실행 파일 10개만 포함합니다. 개발 서버, 테스트, 문서, Git 설정, 인증 정보는 들어가지 않습니다. GitHub Actions 실행의 Artifacts에서도 같은 ZIP을 받을 수 있습니다.

## 실패와 재실행

- 설정이 빠지면 누락된 이름을 표시하고 네트워크 요청 전에 중단합니다.
- 태그와 버전이 다르거나 `main`에 포함되지 않은 커밋이면 중단합니다.
- 업로드 처리가 완료되기 전에는 심사를 요청하지 않습니다.
- 같은 버전이 이미 게시됐거나 심사 중이면 중복 제출하지 않고 해당 상태를 알려줍니다.
- 다른 버전이 심사 중이거나 승인 후 대기 중이면 기존 요청을 덮어쓰지 않습니다. 개발자 대시보드에서 먼저 처리합니다.
- 인증 실패(HTTP 400/401), 권한 실패(403), 스토어 검증 오류가 발생하면 인증 값과 대시보드를 확인합니다. 응답 본문이나 인증 값은 Actions 로그에 출력하지 않습니다.
- 업로드 또는 제출 직후 연결이 끊겼다면 대시보드에서 상태를 먼저 확인합니다. API 쓰기 요청을 자동으로 반복하지 않습니다.
- 심사 결과와 추가 요청은 개발자 대시보드에서 확인합니다. 워크플로가 심사가 끝날 때까지 기다리지는 않습니다.

구현 기준: [업로드 API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload), [상태 조회 API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus), [게시 API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish).
