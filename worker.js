// Analysis engine: Python (Pyodide) in a Web Worker, so the page never freezes.
// Loads app.py and drives it through bridge.py. Files are processed in this browser
// tab and are never uploaded anywhere.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
importScripts(PYODIDE + "pyodide.js");

const WHEELS = [
  "blinker-1.9.0-py3-none-any.whl",
  "click-8.1.8-py3-none-any.whl",
  "itsdangerous-2.2.0-py3-none-any.whl",
  "werkzeug-3.1.3-py3-none-any.whl",
  "flask-3.1.3-py3-none-any.whl",
  "et_xmlfile-2.0.0-py3-none-any.whl",
  "openpyxl-3.1.5-py2.py3-none-any.whl",
];
// web path -> name app.py expects on its own disk
const APP_FILES = {
  "py/app.py": "app.py",
  "py/bridge.py": "bridge.py",
  "py/template.xlsx": "Portfolio Analysis.xlsx",
  "py/Theme1.thmx": "Theme1.thmx",
};
// Same libraries by name, for when the bundled wheels cannot be served (see boot()).
const PYPI = ["flask==3.1.3", "openpyxl==3.1.5"];
const base = new URL(".", self.location.href).href;
const status = text => self.postMessage({ type: "status", text });

// Fetch one of our own files and refuse anything that is not what we asked for. A host
// that is missing the file often answers 200 with an HTML page, which then blows up deep
// inside Python as "File is not a zip file". Fail here instead, naming the file.
async function getFile(path, zip) {
  const r = await fetch(base + path, { cache: "no-cache" });
  const b = new Uint8Array(await r.arrayBuffer());
  const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
  if (!r.ok || (zip && !isZip)) {
    const head = new TextDecoder().decode(b.slice(0, 80)).replace(/\s+/g, " ").trim();
    throw new Error(`${path} respondió HTTP ${r.status} (${r.headers.get("content-type") || "sin tipo"})` +
                    (head ? `: "${head}"` : ""));
  }
  return b;
}

async function boot() {
  status("Cargando Python...");
  const py = await loadPyodide({ indexURL: PYODIDE });
  status("Cargando librerías...");
  await py.loadPackage(["micropip", "sqlite3", "pillow", "markupsafe", "jinja2"]);

  // 1) bundled wheels, unpacked straight into site-packages (no network beyond this site)
  let localErr = null;
  try {
    const wheels = await Promise.all(WHEELS.map(w => getFile("wheels/" + w, true)));
    py.FS.mkdirTree("/tmp/wheels");
    WHEELS.forEach((w, i) => py.FS.writeFile("/tmp/wheels/" + w, wheels[i]));
    py.runPython(`
import os, site, zipfile
sp = site.getsitepackages()[0]
for w in sorted(os.listdir('/tmp/wheels')):
    zipfile.ZipFile('/tmp/wheels/' + w).extractall(sp)
    os.remove('/tmp/wheels/' + w)
import importlib; importlib.invalidate_caches()
`);
  } catch (e) {
    localErr = String(e && e.message || e);
    console.warn("Bundled wheels unavailable, falling back to PyPI:", localErr);
  }
  // 2) fallback: the same pinned versions from PyPI
  if (localErr) {
    status("Descargando librerías de PyPI...");
    try {
      await py.pyimport("micropip").install(PYPI);
    } catch (e) {
      throw new Error(`No se pudieron cargar las librerías. Archivo local: ${localErr}. ` +
                      `PyPI: ${String(e && e.message || e).trim().split("\n").pop()}`);
    }
  }

  py.FS.mkdirTree("/app");
  for (const [src, dst] of Object.entries(APP_FILES)) {
    const zip = /\.(xlsx|thmx)$/.test(src);
    py.FS.writeFile("/app/" + dst, await getFile(src, zip));
  }
  py.runPython("import sys; sys.path.insert(0, '/app'); import flask, openpyxl");
  const call = py.pyimport("bridge").call;
  self.postMessage({ type: "ready" });
  return { py, call };
}

const engine = boot();
engine.catch(e => self.postMessage({ type: "fatal", text: String(e && e.message || e) }));

// Python is single threaded: run requests strictly one after another.
let queue = Promise.resolve();
self.onmessage = e => {
  const m = e.data;
  queue = queue.then(() => handle(m));
};

async function handle({ id, method, path, body, file }) {
  try {
    const { py, call } = await engine;
    const data = file ? new Uint8Array(file.buf) : null;
    const res = call(method, path, body || null, file ? file.name : null, data);
    const [status, ctype, payload] = res.toJs();
    res.destroy();
    const buf = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    self.postMessage({ id, status, ctype, buf }, [buf.buffer]);
  } catch (err) {
    const text = String(err && err.message || err);
    // keep the last line of a Python traceback, it names the actual error
    const last = text.trim().split("\n").filter(Boolean).pop() || text;
    self.postMessage({ id, error: last, detail: text });
  }
}
