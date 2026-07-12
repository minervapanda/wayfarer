# book — requests for files I don't own

## 2026-07-12 — css/app.css (architect): `#login-gate` ignores the `hidden` attribute

`css/app.css` sets `#login-gate { display: flex; … }`. An element's `hidden` attribute
only applies `display: none` at UA-stylesheet specificity, so this rule overrides it and
the gate stays visible even after `main.js` (local mode) or `auth.js` sets
`$('login-gate').hidden = true`. Observed while smoke-testing the book locally with an
empty `config.js`: the gate covered the app despite `hidden` being set.

Suggested fix in app.css:

```css
#login-gate[hidden] { display: none; }
```

(No changes needed from me — book.js renders fine underneath once the gate hides.)
