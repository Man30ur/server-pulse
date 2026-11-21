package main

import (
	"embed"
	"net/http"
)

//go:embed web/index.html web/app.css web/app.js
var webAssets embed.FS

const webCSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"

func registerWebUI(mux *http.ServeMux) {
	serveAsset := func(path, contentType string) http.HandlerFunc {
		data, err := webAssets.ReadFile(path)
		if err != nil {
			panic("missing embedded asset: " + path)
		}
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Security-Policy", webCSP)
			w.Header().Set("Content-Type", contentType)
			_, _ = w.Write(data)
		}
	}

	mux.HandleFunc("GET /{$}", serveAsset("web/index.html", "text/html; charset=utf-8"))
	mux.HandleFunc("GET /app.css", serveAsset("web/app.css", "text/css; charset=utf-8"))
	mux.HandleFunc("GET /app.js", serveAsset("web/app.js", "application/javascript; charset=utf-8"))
}
