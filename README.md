# 돌아봄 T06 Cloudflare Pages 구성

이 프로젝트는 GitHub Pages를 사용하지 않습니다. 정적 화면은 Cloudflare Pages에서 제공하고, `/api/*` 요청은 Pages Functions로 처리하며, 데이터는 D1(SQLite 호환 서버리스 데이터베이스)에 저장합니다. GitHub Pages에서 요구한 공개 저장소 전환이나 업그레이드 없이, Cloudflare Pages에 비공개 GitHub 저장소를 연결해 배포할 수 있습니다. 소스 저장소는 비공개로 두어도 결과 사이트 URL은 공개됩니다.

Cloudflare 공식 문서는 Pages Git 통합에서 비공개 저장소도 지원하며, Pages Functions가 D1 바인딩을 사용할 수 있다고 안내합니다. 다만 Cloudflare 계정 연결과 배포 프로젝트 생성은 계정 소유자가 진행해야 합니다.

## 프로젝트 파일

- `public/`: 정적 HTML·CSS·브라우저 코드와 보안 헤더
- `functions/api/[[path]].js`: 계획·할 일·기록·회고·내보내기 API
- `migrations/0001_initial.sql`: D1 데이터베이스 표와 제약 조건
- `wrangler.toml`: Pages 빌드 경로와 D1 바인딩
- `contracts/pds-schema-v2.json`: 과제에서 요구한 데이터 계약

## D1 데이터베이스 준비

Node.js와 npm이 설치된 환경에서 프로젝트 폴더로 이동해 아래 명령을 실행합니다.

```sh
npx wrangler login
npx wrangler d1 create t06-db
```

Cloudflare가 출력한 데이터베이스 ID를 `wrangler.toml`의 `database_id`에 넣습니다. 그다음 초기 표를 원격 D1에 적용합니다.

```sh
npx wrangler d1 migrations apply t06-db --remote
```

`wrangler.toml`의 ID는 의도적인 자리표시자입니다. 실제 계정의 D1 ID를 입력하기 전에는 배포 구성이 완성되지 않습니다. 비밀키나 계정 토큰은 소스 파일에 쓰지 마세요. Wrangler 로그인 정보는 로컬 개발 환경에만 보관합니다.

## 비공개 저장소에서 배포

1. 이 프로젝트 파일을 비공개 GitHub 저장소에 올립니다.
2. Cloudflare 대시보드의 Workers & Pages에서 Pages 프로젝트를 만들고 Git 연결을 선택합니다.
3. 해당 비공개 저장소에 대한 Cloudflare Git 통합 권한을 승인하고 저장소를 선택합니다.
4. 빌드 명령은 비워 두고 출력 디렉터리를 `public`으로 지정합니다. 저장소 루트에 이 프로젝트가 없다면 프로젝트 하위 폴더를 root directory로 지정합니다.
5. `wrangler.toml`의 D1 바인딩 `DB`가 해당 데이터베이스를 가리키는지 확인하고 배포합니다.
6. Cloudflare Pages가 제공하는 공개 URL을 열어 저장하고, 새로고침 후에도 값이 남는지 확인합니다.

배포 후 공개 URL은 Cloudflare Pages 대시보드에 표시됩니다. 현재 저장소 URL과 Cloudflare 계정이 주어지지 않았으므로 이 문서는 배포 가능한 소스와 절차를 제공합니다. 실제 사이트나 제출용 주소가 이미 만들어졌다고 뜻하지는 않습니다.

## 로컬 미리보기

```sh
npx wrangler pages dev public
```

Wrangler의 로컬 D1 저장소를 사용합니다. Cloudflare 문서 기준으로 Pages Functions와 D1은 로컬 개발 시 Wrangler를 통해 연결됩니다. 운영 데이터와 로컬 미리보기 데이터는 서로 분리됩니다.

## 과제 기능

- 계획 기간·우선순위·성공 기준·예상 시간 저장 및 수정 이력
- 할 일 생성·수정·완료·되돌리기·소프트 삭제, 검색·필터·안정 정렬
- 시작·끝 시각, 실제 시간, 막힘 이유 실행 기록
- 완료 처리에서 고유 요청 키와 D1 배치로 중복 기록 방지
- 서울 시간 기준 지연 계산과 기간 회고
- 회고 집계 숫자에서 관련 할 일 및 실행 기록으로 이동
- 개선점 한 줄을 다음 계획으로 인계
- 전체 자료 JSON 내보내기
- 첫 화면 공개 링크 안내와 사용자 입력 이스케이프

## 공개 범위와 사용자 자료

저장소는 비공개로 유지할 수 있지만, 결과 URL을 여는 사용자에게 로그인이나 초대 확인을 요구하지 않습니다. 링크를 아는 사람은 누구나 기록을 볼 수 있으므로 첫 화면에 공개 안내를 유지하고, 민감 정보·비밀번호·토큰·다른 사람의 개인정보는 입력하지 마세요. 계획과 실행 기록은 실제 사용자가 직접 입력해야 하며, 저장소에 임의의 개인 자료를 미리 채우지 않았습니다.
