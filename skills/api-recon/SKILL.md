---
name: api-recon
description: Use when mapping a REST/GraphQL/SOAP API — parse OpenAPI/Swagger/introspection/WSDL, enumerate versioned routes and params, detect auth scheme, seed inventory.
---

# API discovery & enumeration

Goal: enumerate every operation, parameter, and auth requirement into the inventory so `recall gaps` can drive per-endpoint authz/injection testing. APIs hide their surface in specs and JS, not in a crawlable UI.

Save raw specs to `evidence/`; record a distilled `endpoint`/`param`/`tech` set. Missing tool → `record kind=note` or a `blocker`. Stay in scope.

## 1. Find the spec / schema (biggest shortcut)
```bash
for p in openapi.json swagger.json swagger.yaml v2/api-docs v3/api-docs \
         api-docs openapi.yaml swagger/index.html swagger-ui.html \
         .well-known/openapi graphql graphql/schema.json redoc; do
  echo "== $p =="; curl -s -o /dev/null -w "%{http_code}\n" https://TARGET/$p; done
# GraphQL introspection (see api-graphql for the full query):
curl -s https://TARGET/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{__schema{types{name}}}"}' | tee evidence/gql-introspect.json
# SOAP/WSDL:
curl -s "https://TARGET/service?wsdl" | tee evidence/service.wsdl
```

## 2. Parse the spec into endpoints/params
```bash
# list every path + method from an OpenAPI doc
jq -r '.paths | to_entries[] | .key as $p | .value | keys[] as $m | "\($m|ascii_upcase) \($p)"' evidence/openapi.json
# params per operation
jq -r '.paths[][].parameters[]?.name' evidence/openapi.json | sort -u
```
Record each: `record kind=endpoint host=h1 method=POST path=/api/v1/orders params=["status"] auth=bearer`. Note which operations the spec marks as admin/privileged — those are prime BOLA/BFLA targets.

## 3. Harvest endpoints without a spec
```bash
katana -u https://TARGET -jc -d 3 -o evidence/api-urls.txt          # crawl + JS
gau TARGET | grep -E '/api/|/v[0-9]/|\.json' >> evidence/api-urls.txt
curl -s https://TARGET/app.js | grep -oE '/(api|v[0-9])/[a-zA-Z0-9/_{}.-]+' | sort -u
# brute API paths / params
ffuf -u https://TARGET/api/FUZZ -w /usr/share/seclists/Discovery/Web-Content/api/api-endpoints.txt -mc all -fc 404
arjun -u https://TARGET/api/v1/user -m GET      # discover hidden params
```

## 4. Versioned & shadow routes (API9:2023 improper inventory · class=inventory)
- Enumerate **every** version/prefix: `/v1`, `/v2`, `/v3`, `/beta`, `/internal`, `/legacy`, `/staging`, `/test`. Old/undocumented versions often skip newer authz checks — record each as its own endpoint so coverage tracks them separately and every one gets its own BOLA/BFLA pass downstream. A shadow/deprecated endpoint still reachable is itself an API9:2023 finding.
- Try undocumented methods on documented paths (`OPTIONS` to reveal `Allow:`; `PUT`/`DELETE`/`PATCH` where only `GET` is documented).
- A path that returns a suspicious non-404 you can't fully classify is a lead, not noise — `record kind=endpoint` (or a note) so `recall gaps` keeps it in scope rather than dropping it.

## 5. Detect the auth scheme
```bash
curl -sI https://TARGET/api/v1/me                       # 401 + WWW-Authenticate reveals scheme
```
- Identify: Bearer/JWT, API key (header vs query), Basic, session cookie, HMAC-signed, mTLS. Decode any JWT (`jwt_tool <tok>`, or paste into a local decoder) and record claims/alg; note the `alg` and `kid` for the auth playbook in **web-auth-session**.
- Note where the token goes (header name, query param) and whether TLS is enforced. Record as `tech name="auth: JWT bearer"`.

## 6. Seed the inventory & hand off
```
record kind=host value=api.target.test ip=... tech=["kong","node"]
record kind=endpoint host=h1 method=GET path=/api/v1/users/{id} params=["id"] auth=bearer
record kind=param name=id endpoint=e1 location=path
record kind=tech name=GraphQL host=h1
```
Aim for an **exhaustive** inventory — every operation, every parameter, every version — because coverage downstream can only be as complete as what you record here: a route you don't record never gets a BOLA/BFLA test. Then propose first hypotheses (BOLA on **every** `{id}` endpoint, BFLA on **every** admin/privileged op) and run `recall next`. Continue with **api-testing** (REST) or **api-graphql**.

## References
- OWASP API Security Top 10 — 2023 (API9:2023 Improper Inventory Management drives spec/version enumeration) — https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- katana — crawler & JS endpoint parsing (`-jc`, `-d`, `-o`) — https://github.com/projectdiscovery/katana
- OWASP WSTG — Information Gathering (WSTG-INFO-*) & API testing (cite by name)
- OWASP Cheat Sheet Series — REST Security Cheat Sheet (cite by name)
- OpenAPI Specification — spec structure parsed in §2 (cite by name)
