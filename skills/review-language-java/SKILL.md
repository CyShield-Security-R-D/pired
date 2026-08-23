---
name: review-language-java
description: Use when auditing Java/Spring — sources & sinks for SQLi, Runtime.exec, Jackson/native deser, XXE, SpEL/OGNL, reflection, mass assignment, authz gaps.
---

# Java / Spring review

Goal: apply the class skills with Java/Spring-specific source and sink names. Sources are the request-binding annotations and servlet APIs; sinks are the JDBC/exec/deser/XML/expression/reflection APIs below. Aim for **complete** sink coverage — grep every row, then confirm the data flow by reading. Bean validation (`@Valid`) checks shape, not injection safety.

Tools run via `bash`. Widen with `semgrep --config p/java --config p/spring .` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

## Sources (untrusted input)
```bash
rg -n "@RequestParam|@RequestBody|@PathVariable|@RequestHeader|@CookieValue|@ModelAttribute|@RequestPart|HttpServletRequest|getParameter\(|getHeader\(|getInputStream\(|getReader\(|@Value\(.*\x24\{" -g '*.java'
```
Spring MVC: `@RequestParam`, `@RequestBody`, `@PathVariable`, `@RequestHeader`, `@CookieValue`, `@ModelAttribute`, `@RequestPart`. Servlet: `request.getParameter/getHeader/getInputStream/getReader`. JAX-RS: `@QueryParam`, `@PathParam`, `@HeaderParam`.

## SQL injection (CWE-89)
```bash
rg -n "createStatement\(|Statement\s|executeQuery\(\s*['\x22]|executeQuery\(.*\+|executeUpdate\(.*\+|createQuery\(.*\+|createNativeQuery\(.*\+|String\.format.*(SELECT|INSERT|UPDATE|DELETE)|@Query\(.*\+|\.append\(.*(SELECT|WHERE|FROM)|\x24\{" -g '*.java'
```
Vulnerable: `Statement` + string-concatenated SQL, `entityManager.createQuery/createNativeQuery("... " + x)`, JPA `@Query` with concatenation, **MyBatis `${}`** (string substitution) vs safe `#{}` (bind). **Safe:** `PreparedStatement` with `?` placeholders + `setX()`, JPA named parameters (`:name` + `setParameter`).
```java
// VULNERABLE
st.executeQuery("SELECT * FROM u WHERE name='" + name + "'");
// SAFE
PreparedStatement ps = c.prepareStatement("SELECT * FROM u WHERE name=?"); ps.setString(1, name);
```
→ class `sqli`.

## Command injection (CWE-78)
```bash
rg -n "Runtime\.getRuntime\(\)\.exec|new ProcessBuilder|ProcessBuilder\(|\.exec\(|CommandLine\.parse|Commandline" -g '*.java'
```
`Runtime.exec(userString)` and `new ProcessBuilder(userString)` where a single string is split/shelled → injection; the risk peaks when the command is `sh -c <user>`. Pass a fixed program plus a **separate args list** with no shell, and still validate args. → class `cmdi`.

## Deserialization (CWE-502)
```bash
rg -n "ObjectInputStream|readObject\(|readUnshared\(|XMLDecoder|enableDefaultTyping|activateDefaultTyping|@JsonTypeInfo|readValue\(.*Object\.class|SerializationUtils\.deserialize|new Yaml\(\)|Yaml\(\)\.load|XStream|Kryo|Hessian" -g '*.java'
```
`ObjectInputStream.readObject()` on untrusted bytes, Jackson polymorphic typing (`enableDefaultTyping()`/`activateDefaultTyping()` or `@JsonTypeInfo(use=Id.CLASS)`), `XMLDecoder`, XStream default config, SnakeYAML `new Yaml().load()` (no `SafeConstructor`), Kryo/Hessian → gadget-chain RCE. **Safe:** avoid native serialization; SnakeYAML `new Yaml(new SafeConstructor())`; a Jackson allowlist (`PolymorphicTypeValidator`). → class `deser`; see `review-deserialization-ssrf`.

## XXE / unsafe XML (CWE-611, CWE-776)
```bash
rg -n "DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|SAXReader|TransformerFactory|SchemaFactory|Unmarshaller|newSAXParser|XMLReaderFactory|DocumentHelper\.parseText" -g '*.java'
```
Every XML factory is XXE-vulnerable unless it disables DOCTYPE/external entities:
```java
dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true); // SAFE (best)
dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
dbf.setXIncludeAware(false); dbf.setExpandEntityReferences(false);
```
Grep the factory usage, then confirm these are set. Missing = XXE (file read / SSRF / billion-laughs). → class `xxe`.

## Expression injection — SpEL / OGNL / EL (CWE-917)
```bash
rg -n "SpelExpressionParser|parseExpression\(|ExpressionParser|Ognl\.|OgnlUtil|MVEL|ELProcessor|@Value\(.*#\{.*request|TemplateParserContext|scriptEngine|ScriptEngineManager" -g '*.java'
```
User input into `new SpelExpressionParser().parseExpression(x).getValue()`, OGNL (classic Struts2 RCE), MVEL, or JSR-223 `ScriptEngine.eval` = remote code execution. Never evaluate an expression/script built from request data. → class `codeinj`.

## Unsafe reflection (CWE-470)
```bash
rg -n "Class\.forName\(|\.getMethod\(|\.getDeclaredMethod\(|Method\.invoke|\.newInstance\(|ClassLoader|instantiate\(" -g '*.java'
```
`Class.forName(request.x)` / `getMethod(userName).invoke(...)` lets an attacker instantiate/invoke arbitrary classes and methods. Allowlist the permitted class/method names. → class `reflection`.

## SSRF / path / upload / redirect (CWE-918, CWE-22, CWE-434, CWE-601)
```bash
rg -n "new URL\(|HttpURLConnection|RestTemplate|WebClient|HttpClient|openStream\(|openConnection\(|ImageIO\.read\(new URL|new File\(.*(request|param)|Paths\.get\(.*(request|param)|Files\.(read|write|copy)|getResourceAsStream\(.*request|MultipartFile|getOriginalFilename\(|transferTo\(|sendRedirect\(" -g '*.java'
```
- **SSRF:** `RestTemplate`/`WebClient`/`HttpClient`/`URL.openStream` on a user URL, no allowlist → cloud metadata / internal hosts. → class `ssrf`.
- **Path:** `new File(base, requestParam)` / `Paths.get(userPath)` / `Files.read` → traversal. Canonicalize and confirm the result is under base. → class `pathtrav`.
- **Upload:** `MultipartFile.getOriginalFilename()` used as the on-disk path → traversal/arbitrary write; validate type/size, generate the stored name. → class `upload`.
- **Open redirect:** `response.sendRedirect(userValue)` unvalidated. → class `authz`. See `review-deserialization-ssrf` / `review-path-file`.

## Mass assignment / binding (CWE-915)
```bash
rg -n "@ModelAttribute|DataBinder|WebDataBinder|setAllowedFields|setDisallowedFields|@InitBinder|BeanUtils\.(copyProperties|populate)|ModelMapper" -g '*.java'
```
Binding a request directly onto an entity via `@ModelAttribute`/`DataBinder` (or `BeanUtils.populate`) with **no** `@InitBinder` `setAllowedFields(...)` allowlist lets an attacker set unexpected fields (e.g. `role`, `enabled`). **Safe:** bind to a DTO with only the intended fields, or restrict with `setAllowedFields`. → class `authz`.

## Weak crypto & randomness (CWE-327, CWE-328, CWE-338, CWE-916)
```bash
rg -n "MessageDigest\.getInstance\(\s*['\x22](MD5|SHA-?1)|new Random\(|Math\.random\(|Cipher\.getInstance\(\s*['\x22](DES|DESede|RC4|AES/ECB|AES['\x22])|new SecureRandom\(\s*[^)]|TrustManager|checkServerTrusted\s*\(|HostnameVerifier|ALLOW_ALL" -g '*.java'
```
- `MessageDigest.getInstance("MD5"/"SHA-1")` for security → CWE-327/328 (use SHA-256+).
- `java.util.Random`/`Math.random()` for tokens/IDs → predictable; use `java.security.SecureRandom` (CWE-338).
- `Cipher.getInstance("DES"/"RC4"/"AES/ECB/...")`, or AES with no IV → CWE-327 (use AES/GCM with a random IV).
- A `TrustManager` whose `checkServerTrusted` is empty, or a `HostnameVerifier` returning `true` → TLS validation disabled. Password storage: bcrypt/`Argon2`/PBKDF2, not a bare hash (CWE-916). → class `crypto`; see `review-crypto-secrets-handling`.

## Spring Security / authz gaps (CWE-862, CWE-287)
```bash
rg -n "@PreAuthorize|@PostAuthorize|@Secured|@RolesAllowed|hasRole|hasAuthority|antMatchers|requestMatchers|permitAll\(\)|anonymous\(\)|authorizeHttpRequests|authorizeRequests|csrf\(\)\.disable|csrf\(AbstractHttpConfigurer::disable\)|@EnableMethodSecurity|@EnableGlobalMethodSecurity|WebSecurityConfigurerAdapter" -g '*.java'
```
Red flags: `permitAll()`/`anonymous()` on sensitive paths, `csrf().disable()` on a cookie-auth app, controller methods missing `@PreAuthorize`, broad `antMatchers("/**").permitAll()`, and **method security not enabled** (`@PreAuthorize` is silently ignored without `@EnableMethodSecurity` / older `@EnableGlobalMethodSecurity(prePostEnabled=true)`). Compare protected vs unprotected controllers. → class `authz`/`authn`; see `review-authz-authn`.

## Note — Log4Shell / JNDI (hand off to SCA)
Log4j 2 `<2.17.0` message-lookup (`${jndi:ldap://...}`, CVE-2021-44228) is a **dependency** vuln — confirm the version and record it via `review-dependencies-sca` (class `sca`), even if reachability of the log call is uncertain.

## Wire into the loop
```
record kind=hypothesis statement="UserController.get builds JPQL with string concat from @PathVariable" target=e_user class=sqli approach="trace id -> createQuery" outcome=testing
record kind=finding title="XXE in /import (DocumentBuilder default features)" severity=high target=e_import class=xxe cwe=CWE-611 description="DocumentBuilderFactory without disallow-doctype-decl parses uploaded XML" repro="POST /import with DOCTYPE SYSTEM file:///etc/passwd" evidence=["ImportService.java:41"] status=confirmed hypothesisId=y4
```
Refute (set `outcome=refuted`) only when PreparedStatement/named params, a DTD-disabled parser, an allowlist binder, `SecureRandom`, or a real `@PreAuthorize`/matcher guard is genuinely present. Uncertain-but-plausible → keep `outcome=inconclusive` with a note; never silently drop it.

## References
- Spring Security reference — Authorization / Method Security — https://docs.spring.io/spring-security/reference/servlet/authorization/method-security.html
- OWASP Deserialization Cheat Sheet (Java) — https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html
- OWASP XML External Entity Prevention Cheat Sheet (Java) — https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html
- CWE-917: Expression Language Injection (SpEL/OGNL) — https://cwe.mitre.org/data/definitions/917.html
- CWE-502: Deserialization of Untrusted Data — https://cwe.mitre.org/data/definitions/502.html
- CVE-2021-44228: Log4Shell (Log4j JNDI lookup) — https://nvd.nist.gov/vuln/detail/CVE-2021-44228
