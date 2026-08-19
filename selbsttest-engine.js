/*
 * EF Informatik -- gemeinsame Logik fuer alle Selbsttest-Seiten.
 *
 * Jede Aufgaben-Seite bindet dieses Skript ein (nach pyodide.js) und ruft
 * anschliessend SelbsttestEngine.init({...}) mit ihrer eigenen Konfiguration
 * auf. Die Seite selbst enthaelt nur noch: Titel/Anleitungstext (HTML) +
 * das init()-Konfigurationsobjekt. Aenderungen an der Testlogik (z. B.
 * Bugfixes) muessen dadurch nur an dieser einen Stelle gemacht werden,
 * nicht in jeder einzelnen Aufgaben-Datei.
 *
 * Erwartetes HTML-Grundgeruest pro Seite (IDs muessen exakt so heissen):
 *   <textarea id="code"></textarea>
 *   <button id="runBtn">Code testen</button>
 *   <div id="status"></div>
 *   <div id="results"></div>
 */
(function () {
  "use strict";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Tiefenvergleich: unterstuetzt einzelne Werte (Zahlen, Strings, None/null)
  // genauso wie Tupel/Listen (z. B. Rueckgabewerte der Form (name, anzahl)).
  // Wichtig: pyodide.toJs() wandelt Python None je nach Kontext zu JS
  // `undefined` (nicht `null`) -- beide werden hier als gleichwertig behandelt,
  // sonst schlaegt der Vergleich fuer "nicht gefunden"-Faelle faelschlich fehl.
  function normalisieren(x) {
    return x === undefined ? null : x;
  }

  function werteGleich(a, b) {
    a = normalisieren(a);
    b = normalisieren(b);
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, i) => werteGleich(v, b[i]));
    }
    return a === b;
  }

  function formatWertStandard(v) {
    if (Array.isArray(v)) return "(" + v.map(formatWertStandard).join(", ") + ")";
    if (v === null || v === undefined) return "None";
    return String(v);
  }

  function init(config) {
    const {
      funktionsname,
      testCases,
      pyodideIndexURL = "./pyodide/",
      vergleich = werteGleich,
      formatWert = formatWertStandard,
    } = config;

    if (!funktionsname || !Array.isArray(testCases)) {
      throw new Error("SelbsttestEngine.init: 'funktionsname' und 'testCases' sind Pflichtfelder.");
    }

    const btn = document.getElementById("runBtn");
    const statusEl = document.getElementById("status");
    const resultsEl = document.getElementById("results");
    const codeEl = document.getElementById("code");

    let pyodideInstance = null;
    let pyodideLoading = null;

    async function getPyodide() {
      if (pyodideInstance) return pyodideInstance;
      if (!pyodideLoading) {
        pyodideLoading = loadPyodide({ indexURL: pyodideIndexURL });
      }
      pyodideInstance = await pyodideLoading;
      return pyodideInstance;
    }

    // Wandelt ein JS-Argument (z. B. ein Array) in ein passendes Python-Objekt,
    // damit es der Studierenden-Funktion uebergeben werden kann.
    function toPyArg(pyodide, arg) {
      if (Array.isArray(arg) || (arg && typeof arg === "object")) {
        return pyodide.toPy(arg);
      }
      return arg;
    }

    async function runTests() {
      btn.disabled = true;
      resultsEl.innerHTML = "";
      statusEl.textContent = pyodideInstance
        ? "Teste..."
        : "Python-Umgebung wird geladen (einmalig, benötigt Internet)...";

      let pyodide;
      try {
        pyodide = await getPyodide();
      } catch (e) {
        statusEl.textContent = "";
        const isFileProtocol = location.protocol === "file:";
        const hint = isFileProtocol
          ? `<p>Diese Seite wurde direkt als Datei geöffnet (Adresse beginnt mit <code>file://</code>).
             Aus Sicherheitsgründen blockieren Browser das Nachladen der Python-Umgebung in diesem Fall.
             Bitte die vom Lehrer bereitgestellte <strong>Weblink-Version</strong> verwenden statt die Datei lokal zu öffnen.</p>`
          : `<p><strong>Python-Umgebung konnte nicht geladen werden.</strong> Internetverbindung prüfen und nochmals versuchen.</p>`;
        resultsEl.innerHTML = `${hint}<pre class="error-box">${escapeHtml(e.message || e)}</pre>`;
        btn.disabled = false;
        return;
      }

      statusEl.textContent = "Teste...";
      const code = codeEl.value;

      // Frischer Namensraum pro Durchlauf: verhindert, dass Funktionen/Variablen
      // aus einem vorherigen Testlauf (z. B. ein zuvor definierter, inzwischen
      // umbenannter oder entfernter Funktionsname) fälschlich weiterleben.
      const namespace = pyodide.globals.get("dict")();

      try {
        pyodide.runPython(code, { globals: namespace });
      } catch (e) {
        statusEl.textContent = "";
        resultsEl.innerHTML = `<p><strong>Fehler beim Ausführen Ihres Codes:</strong></p>
          <pre class="error-box">${escapeHtml(e.message)}</pre>`;
        btn.disabled = false;
        namespace.destroy();
        return;
      }

      const fn = namespace.get(funktionsname);
      if (!fn || typeof fn.call !== "function") {
        statusEl.textContent = "";
        resultsEl.innerHTML = `<p><strong>Keine Funktion namens <code>${escapeHtml(funktionsname)}</code> gefunden.</strong>
          Prüfen Sie den Funktionsnamen.</p>`;
        btn.disabled = false;
        namespace.destroy();
        return;
      }

      let passed = 0;
      let rows = "";

      for (const tc of testCases) {
        let actualDisplay, ok;
        try {
          const pyArgs = tc.args.map((arg) => toPyArg(pyodide, arg));
          const result = fn(...pyArgs);
          const actual = (result && typeof result.toJs === "function")
            ? result.toJs({ create_proxies: false })
            : result;
          ok = vergleich(actual, tc.expected);
          actualDisplay = formatWert(actual);
        } catch (e) {
          ok = false;
          // .filter(Boolean): Python-Tracebacks enden meist mit einem
          // Zeilenumbruch, sonst liefert .pop() faelschlich einen leeren String.
          const zeilen = (e.message || e).toString().split("\n").filter(Boolean);
          actualDisplay = "Fehler: " + (zeilen.pop() || "unbekannter Fehler");
        }
        if (ok) passed++;
        rows += `<tr>
          <td>${escapeHtml(tc.label)}</td>
          <td>${escapeHtml(formatWert(tc.expected))}</td>
          <td>${escapeHtml(actualDisplay)}</td>
          <td class="${ok ? "status-pass" : "status-fail"}">${ok ? "bestanden" : "fehlgeschlagen"}</td>
        </tr>`;
      }

      const allPass = passed === testCases.length;
      resultsEl.innerHTML = `
        <table>
          <thead>
            <tr><th>Testfall</th><th>Erwartet</th><th>Erhalten</th><th>Status</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div id="summary" class="${allPass ? "all-pass" : "some-fail"}">${passed} / ${testCases.length} Testfälle bestanden</div>
      `;
      statusEl.textContent = "";
      btn.disabled = false;
      namespace.destroy();
    }

    btn.addEventListener("click", runTests);
  }

  window.SelbsttestEngine = { init, werteGleich, formatWertStandard };
})();
