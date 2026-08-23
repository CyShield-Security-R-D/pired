---
name: review-language-java
description: Use when auditing Java/Spring — request sources, Statement vs PreparedStatement, Runtime.exec, ObjectInputStream, XXE, SpEL/OGNL, @PreAuthorize gaps.
---

# Java / Spring review

Goal: apply the class skills with Java/Spring-specific source and sink names. Sources are the request-binding annotations and servlet APIs; sinks are the JDBC/exec/deser/XML/expression APIs below.

Tools run via `bash`. Widen with `semgrep --config p/java --config p/spring .` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

## Sources (untrusted input)
```bash
rg -n "@RequestParam|@RequestBody|@PathVariable|@RequestHeader|@CookieValue|@ModelAttribute|HttpServletRequest|getParameter\(|getHeader\(|getInputStream\(" -g '*.java'
```
Spring MVC: `@RequestParam`, `@RequestBody`, `@PathVariable`, `@RequestHeader`, `@CookieValue`. Servlet: `request.getParameter/getHeader/getInputStream`. Bean validation (`@Valid`) checks shape, not injection safety.

## SQL — CWE-89
```bash
rg -n "createStatement\(|Statement\s|executeQuery\(\s*\"|executeQuery\(.*\+|createQuery\(.*\+|String\.format.*(SELECT|INSERT|UPDATE|DELETE)|@Query\(.*\+|\.append\(.*(SELECT|WHERE)" -g '*.java'
```
Vulnerable: `Statement` + string-concatenated SQL, `entityManager.createQuery("... " + x)`, JPA `@Query` with concatenation, MyBatis `${}` (vs safe `#{}`). Safe: `PreparedStatement` with `?` placeholders and `setX()`, JPA named parameters (`:name` + `setParameter`).
```java
// VULNERABLE
st.executeQuery("SELECT * FROM u WHERE name='" + name + "'");
// SAFE
PreparedStatement ps = c.prepareStatement("SELECT * FROM u WHERE name=?"); ps.setString(1, name);
```

## Command execution — CWE-78
```bash
rg -n "Runtime\.getRuntime\(\)\.exec|ProcessBuilder|new ProcessBuilder" -g '*.java'
```
`Runtime.exec(userString)` and `new ProcessBuilder(userString)` where a single string is split/shelled → injection. Passing a fixed program plus a **separate args list** and no shell is safer; still validate args.

## Deserialization — CWE-502
```bash
rg -n "ObjectInputStream|readObject\(|readUnshared\(|XMLDecoder|enableDefaultTyping|@JsonTypeInfo|readValue\(.*Object\.class|SerializationUtils\.deserialize|Yaml\(\)\.load|XStream" -g '*.java'
```
`ObjectInputStream.readObject()` on untrusted bytes, Jackson `enableDefaultTyping()` / `@JsonTypeInfo(use=Id.CLASS)`, `XMLDecoder`, XStream default config, SnakeYAML `new Yaml().load()` → gadget-chain RCE. See `review-deserialization-ssrf`.

## XXE — CWE-611
```bash
rg -n "DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|SAXReader|TransformerFactory|SchemaFactory|Unmarshaller|newSAXParser" -g '*.java'
```
Vulnerable unless the factory disables DOCTYPE/external entities:
```java
dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true); // SAFE
dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
```
Grep the factory usage, then confirm these features are set. Missing = XXE.

## Expression injection — SpEL / OGNL — CWE-917
```bash
rg -n "SpelExpressionParser|parseExpression\(|ExpressionParser|Ognl\.|OgnlUtil|MVEL|@Value\(.*#\{.*request|TemplateParserContext" -g '*.java'
```
User input into `SpelExpressionParser().parseExpression(x).getValue()` or OGNL (classic Struts2 RCE) = remote code execution. Never evaluate an expression built from request data.

## SSRF / path / redirect
```bash
rg -n "new URL\(|HttpURLConnection|RestTemplate|WebClient|HttpClient|openStream\(|ImageIO\.read\(new URL|new File\(.*request|Files\.(read|write)|getResourceAsStream\(.*request|sendRedirect\(" -g '*.java'
```
- SSRF: `RestTemplate`/`WebClient`/`URL.openStream` on a user URL → `review-deserialization-ssrf`.
- Path: `new File(base, request param)` / `Files.read` → `review-path-file`.
- Open redirect: `response.sendRedirect(userValue)` (CWE-601).

## Spring Security / authz gaps
```bash
rg -n "@PreAuthorize|@PostAuthorize|@Secured|@RolesAllowed|hasRole|hasAuthority|antMatchers|requestMatchers|permitAll\(\)|authorizeHttpRequests|csrf\(\)\.disable|WebSecurityConfigurerAdapter" -g '*.java'
```
Red flags: `permitAll()` on sensitive paths, `csrf().disable()` on a cookie-auth app, controller methods missing `@PreAuthorize`, broad `antMatchers("/**").permitAll()`, method security not enabled. Compare protected vs unprotected controllers → `review-authz-authn`.

## Wire into the loop
```
record kind=hypothesis statement="UserController.get builds JPQL with string concat from @PathVariable" target=e_user class=sqli approach="trace id -> createQuery" outcome=testing
record kind=finding title="XXE in /import (DocumentBuilder default features)" severity=high target=e_import class=xxe cwe=CWE-611 description="DocumentBuilderFactory without disallow-doctype-decl parses uploaded XML" repro="POST /import with DOCTYPE SYSTEM file:///etc/passwd" evidence=["ImportService.java:41"] status=confirmed hypothesisId=y4
```
Refute when PreparedStatement/named params, DTD-disabled parser, or a real `@PreAuthorize`/matcher guard is present.
