(function () {
  "use strict";

  var selectedByEvent = {};
  var scheduled = false;

  function text(el) {
    return el ? String(el.textContent || "").trim() : "";
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setDisplay(el, show) {
    if (!el) return;
    var next = show ? "" : "none";
    if (el.style.display !== next) el.style.display = next;
  }

  function currentEventKey(root) {
    var cta = root.querySelector(".cv2-head .cta");
    var m = /#(\d+)/.exec(text(cta));
    return m ? m[1] : text(cta);
  }

  function storageKey(eventKey) {
    return "imortais:confirm-party-filter:" + String(eventKey || "unknown");
  }

  function loadSelected(eventKey) {
    if (Object.prototype.hasOwnProperty.call(selectedByEvent, eventKey)) {
      return selectedByEvent[eventKey];
    }
    var value = null;
    try {
      var raw = sessionStorage.getItem(storageKey(eventKey));
      if (raw && raw !== "all") {
        var n = Number(raw);
        value = Number.isFinite(n) ? n : null;
      }
    } catch (_e) {}
    selectedByEvent[eventKey] = value;
    return value;
  }

  function saveSelected(eventKey, party) {
    selectedByEvent[eventKey] = party;
    try {
      sessionStorage.setItem(storageKey(eventKey), party == null ? "all" : String(party));
    } catch (_e) {}
  }

  function rowData(row) {
    var cells = row ? row.querySelectorAll("td") : [];
    var player = row && row.querySelector(".cv2-player");
    var name = "";
    if (player) {
      if (player.firstChild && player.firstChild.nodeType === 3) {
        name = String(player.firstChild.nodeValue || "").trim();
      } else {
        name = text(player).replace(/▦/g, "").trim();
      }
    }

    var weapon = "";
    if (cells[0]) {
      var muted = cells[0].querySelector(".cv2-muted");
      weapon = text(muted);
    }

    var planned = null;
    var actual = null;
    var plannedLabel = cells[2] ? text(cells[2]) : "—";
    var actualLabel = cells[3] ? text(cells[3]) : "Não visto";
    var pm = /PT\s+(\d+)/i.exec(plannedLabel);
    var am = /PT\s+(\d+)/i.exec(actualLabel);
    if (pm) planned = Number(pm[1]);
    if (am) actual = Number(am[1]);

    return {
      row: row,
      name: name,
      weapon: weapon,
      slot: cells[1] ? text(cells[1]) : "—",
      planned: planned,
      plannedLabel: plannedLabel,
      actual: actual,
      actualLabel: actualLabel,
      discord: cells[4] ? text(cells[4]) : "",
      albion: cells[5] ? text(cells[5]) : "",
      state: cells[6] ? text(cells[6]) : "",
      observation: cells[7] ? text(cells[7]) : ""
    };
  }

  function situationForParty(x, party) {
    if (x.planned === party && x.actual === party) {
      return { label: "CORRETO", cls: "ok", order: 0 };
    }
    if (x.planned === party && x.actual == null) {
      return { label: "DEVERIA ESTAR AQUI · NÃO VISTO", cls: "missing", order: 1 };
    }
    if (x.planned === party && x.actual !== party) {
      return {
        label: "DEVERIA ESTAR AQUI · ESTÁ " + (x.actualLabel || "EM OUTRA PT"),
        cls: "wrong",
        order: 2
      };
    }
    if (x.actual === party && x.planned !== party) {
      return {
        label: "NÃO DEVERIA ESTAR AQUI · ESCALADO " + (x.plannedLabel || "RESERVA"),
        cls: "intruder",
        order: 3
      };
    }
    return { label: x.state || "—", cls: "neutral", order: 9 };
  }

  function ensureStyle() {
    if (document.getElementById("confirm-party-filter-style-v2")) return;
    var style = document.createElement("style");
    style.id = "confirm-party-filter-style-v2";
    style.textContent =
      ".cv2-party{cursor:pointer;transition:opacity .12s ease,border-color .12s ease,box-shadow .12s ease,transform .12s ease}" +
      ".cv2-party:hover{transform:translateY(-1px);border-color:#4a6688}" +
      ".cv2-party.party-filter-selected{border-color:#4a97ff!important;box-shadow:0 0 0 1px rgba(74,151,255,.3) inset}" +
      ".cv2-party.party-filter-dim{opacity:.42}" +
      ".party-filterbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:10px 0 10px}" +
      ".party-filterbtn{border:1px solid #2b3a50;border-radius:8px;background:#101822;color:#93a3b8;padding:7px 11px;font:800 9px Inter,system-ui,sans-serif;cursor:pointer}" +
      ".party-filterbtn:hover{border-color:#53709a;color:#dbe7f5}" +
      ".party-filterbtn.on{border-color:#4a97ff;background:#16283c;color:#82bfff;box-shadow:0 0 0 1px rgba(74,151,255,.14) inset}" +
      ".party-filterhint{margin-left:auto;color:#8190a5;font-size:9px}" +
      ".party-problem-badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;margin-left:7px;border:1px solid #6b2a31;border-radius:999px;background:#2d1115;color:#ff8790;font-size:8px;font-weight:900;vertical-align:middle}" +
      ".party-problem-badge.ok{border-color:#25593b;background:#0d281a;color:#7fe3a4}" +
      ".party-audit-stack{display:grid;gap:12px;margin:10px 0 14px}" +
      ".party-audit-section{border:1px solid #28374b;border-radius:11px;background:linear-gradient(180deg,#111923,#0c121a);overflow:hidden}" +
      ".party-audit-section.selected{border-color:#4a97ff;box-shadow:0 0 0 1px rgba(74,151,255,.18) inset}" +
      ".party-audit-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid #243040;background:#111a25}" +
      ".party-audit-title{font-family:Cinzel,Georgia,serif;font-weight:900;font-size:17px}" +
      ".party-audit-meta{display:flex;gap:10px;flex-wrap:wrap;color:#8798ae;font-size:9px}" +
      ".party-audit-meta b{color:#e5edf6}" +
      ".party-audit-tablebox{overflow-x:auto}" +
      ".party-audit-table{width:100%;border-collapse:collapse;font-size:10px}" +
      ".party-audit-table th{padding:7px 10px;text-align:left;color:#7085a3;font-size:8px;letter-spacing:.05em;border-bottom:1px solid #223044}" +
      ".party-audit-table td{padding:8px 10px;border-bottom:1px solid #1d2939;vertical-align:middle}" +
      ".party-audit-table tr:last-child td{border-bottom:0}" +
      ".party-audit-player b{font-size:11px}.party-audit-player span{display:block;margin-top:2px;color:#718198;font-size:8px}" +
      ".party-audit-status{display:inline-block;padding:3px 6px;border-radius:999px;font-size:8px;font-weight:900;white-space:nowrap}" +
      ".party-audit-status.ok{background:#10351f;color:#7ee3a4;border:1px solid #28633f}" +
      ".party-audit-status.missing{background:#3a2b0d;color:#f2ca70;border:1px solid #6f551c}" +
      ".party-audit-status.wrong{background:#35194f;color:#cda2ff;border:1px solid #613b85}" +
      ".party-audit-status.intruder{background:#3b1519;color:#ff9299;border:1px solid #733038}" +
      ".party-audit-status.neutral{background:#1b2634;color:#9fb0c5;border:1px solid #33445a}" +
      ".party-audit-empty{padding:14px;color:#718198;font-size:10px}" +
      ".party-audit-note{padding:8px 12px;color:#657790;font-size:8px;border-top:1px solid #1f2b3a}";
    document.head.appendChild(style);
  }

  function renderPartySections(root, rows, parties, selectedParty) {
    var grid = root.querySelector(".cv2-party-grid");
    if (!grid) return;

    var stack = root.querySelector(".party-audit-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "party-audit-stack";
      var legend = grid.nextElementSibling;
      if (legend && legend.classList.contains("cv2-legend")) {
        legend.parentNode.insertBefore(stack, legend.nextSibling);
      } else {
        grid.parentNode.insertBefore(stack, grid.nextSibling);
      }
    }

    var visibleParties = selectedParty == null
      ? parties.slice()
      : parties.filter(function (p) { return p === Number(selectedParty); });

    var html = visibleParties.map(function (party) {
      var relevant = rows.filter(function (x) {
        return x.planned === party || x.actual === party;
      }).map(function (x) {
        var sit = situationForParty(x, party);
        return { x: x, sit: sit };
      }).sort(function (a, b) {
        if (a.sit.order !== b.sit.order) return a.sit.order - b.sit.order;
        var sa = Number(a.x.slot);
        var sb = Number(b.x.slot);
        if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
        return String(a.x.name).localeCompare(String(b.x.name));
      });

      var planned = rows.filter(function (x) { return x.planned === party; });
      var correct = planned.filter(function (x) { return x.actual === party; }).length;
      var missing = planned.filter(function (x) { return x.actual == null; }).length;
      var wrongOut = planned.filter(function (x) { return x.actual != null && x.actual !== party; }).length;
      var intruders = rows.filter(function (x) { return x.actual === party && x.planned !== party; }).length;

      var body = relevant.length ? relevant.map(function (entry) {
        var x = entry.x;
        return '<tr>' +
          '<td class="party-audit-player"><b>' + esc(x.name || "?") + '</b><span>' + esc(x.weapon || "") + '</span></td>' +
          '<td>' + esc(x.slot || "—") + '</td>' +
          '<td>' + esc(x.plannedLabel || "Reserva") + '</td>' +
          '<td>' + esc(x.actualLabel || "Não visto") + '</td>' +
          '<td><span class="party-audit-status ' + esc(entry.sit.cls) + '">' + esc(entry.sit.label) + '</span></td>' +
          '<td>' + esc(x.discord || "—") + '</td>' +
          '<td>' + esc(x.albion || "—") + '</td>' +
          '</tr>';
      }).join("") : '<tr><td colspan="7" class="party-audit-empty">Nenhum jogador relacionado a esta PT.</td></tr>';

      return '<section class="party-audit-section' + (selectedParty === party ? ' selected' : '') + '" data-party-audit-section="' + party + '">' +
        '<div class="party-audit-head">' +
          '<div class="party-audit-title">PT ' + party + '</div>' +
          '<div class="party-audit-meta">' +
            '<span>Escalados <b>' + planned.length + '</b></span>' +
            '<span>Corretos <b>' + correct + '</b></span>' +
            '<span>Não vistos <b>' + missing + '</b></span>' +
            '<span>Em outra PT <b>' + wrongOut + '</b></span>' +
            '<span>Intrusos <b>' + intruders + '</b></span>' +
          '</div>' +
        '</div>' +
        '<div class="party-audit-tablebox"><table class="party-audit-table">' +
          '<thead><tr><th>JOGADOR</th><th>SLOT</th><th>DEVERIA</th><th>ESTÁ</th><th>SITUAÇÃO</th><th>DISCORD</th><th>ALBION</th></tr></thead>' +
          '<tbody>' + body + '</tbody>' +
        '</table></div>' +
        '<div class="party-audit-note">Esta PT mostra quem deveria estar aqui e também quem foi detectado aqui sem ter sido escalado para ela.</div>' +
      '</section>';
    }).join("");

    if (stack.innerHTML !== html) stack.innerHTML = html;
  }

  function filterAttention(root, rows, selectedParty) {
    var partyByName = {};
    rows.forEach(function (x) {
      if (x.name) partyByName[String(x.name).trim().toLowerCase()] = x.planned;
    });

    var attention = Array.prototype.slice.call(root.querySelectorAll(".cv2-attention"));
    var visible = 0;

    attention.forEach(function (item) {
      var title = text(item.querySelector("b")).toLowerCase();
      var owner = null;

      Object.keys(partyByName).some(function (name) {
        if (title.indexOf(name) === 0) {
          owner = partyByName[name];
          return true;
        }
        return false;
      });

      if (owner == null) {
        var detail = text(item.querySelector("small"));
        var m = /deveria\s+PT\s+(\d+)/i.exec(detail) || /Escalado para\s+PT\s+(\d+)/i.exec(detail);
        if (m) owner = Number(m[1]);
      }

      var show = selectedParty == null || owner === Number(selectedParty);
      setDisplay(item, show);
      if (show) visible++;
    });

    var danger = root.querySelector(".cv2-panel-head.danger");
    if (danger) {
      var h = danger.querySelector("h3");
      var count = danger.querySelector(".cv2-count");
      if (h) h.textContent = selectedParty == null ? "⚠ Precisa de atenção" : "⚠ Precisa de atenção · PT " + selectedParty;
      if (count) count.textContent = String(visible);
    }

    var empty = root.querySelector(".auditok");
    if (empty) {
      var showEmpty = selectedParty == null ? attention.length === 0 : visible === 0;
      setDisplay(empty, showEmpty);
      if (selectedParty != null && visible === 0) {
        empty.textContent = "✅ Nenhuma divergência crítica detectada nesta PT.";
      }
    }
  }

  function apply() {
    scheduled = false;

    var root = document.getElementById("view-confirm");
    if (!root || !root.querySelector(".cv2-shell")) return;

    ensureStyle();

    var eventKey = currentEventKey(root);
    var selectedParty = loadSelected(eventKey);

    var rawRows = Array.prototype.slice.call(root.querySelectorAll(".cv2-table tbody tr")).filter(function (r) {
      return r.querySelectorAll("td").length >= 7;
    });
    if (!rawRows.length) return;

    var rows = rawRows.map(rowData);

    var cards = Array.prototype.slice.call(root.querySelectorAll(".cv2-party"));
    var parties = [];

    cards.forEach(function (card) {
      var name = card.querySelector(".cv2-party-name");
      var m = /PT\s+(\d+)/i.exec(text(name));
      if (!m) return;
      var p = Number(m[1]);
      card.setAttribute("data-party-filter", String(p));
      if (parties.indexOf(p) < 0) parties.push(p);
    });

    rows.forEach(function (x) {
      [x.planned, x.actual].forEach(function (p) {
        if (p != null && parties.indexOf(Number(p)) < 0) parties.push(Number(p));
      });
    });

    parties.sort(function (a, b) { return a - b; });

    if (selectedParty != null && parties.indexOf(Number(selectedParty)) < 0) {
      selectedParty = null;
      saveSelected(eventKey, null);
    }

    var grid = root.querySelector(".cv2-party-grid");
    var bar = root.querySelector(".party-filterbar");
    if (!bar && grid) {
      bar = document.createElement("div");
      bar.className = "party-filterbar";
      grid.parentNode.insertBefore(bar, grid);
    }

    if (bar) {
      var desired = '<button class="party-filterbtn' + (selectedParty == null ? ' on' : '') + '" data-party-filter-all="1">TODAS</button>' +
        parties.map(function (p) {
          return '<button class="party-filterbtn' + (Number(selectedParty) === p ? ' on' : '') + '" data-party-filter-button="' + p + '">PT ' + p + '</button>';
        }).join("") +
        '<span class="party-filterhint">TODAS mostra PT1, depois PT2, depois PT3... · clique numa PT apenas para isolá-la</span>';
      if (bar.innerHTML !== desired) bar.innerHTML = desired;
    }

    cards.forEach(function (card) {
      var p = Number(card.getAttribute("data-party-filter"));
      card.classList.toggle("party-filter-selected", selectedParty != null && p === Number(selectedParty));
      card.classList.toggle("party-filter-dim", selectedParty != null && p !== Number(selectedParty));

      var plannedProblems = rows.filter(function (x) {
        return x.planned === p && x.actual !== p;
      }).length;
      var intruders = rows.filter(function (x) {
        return x.actual === p && x.planned !== p;
      }).length;
      var problemCount = plannedProblems + intruders;

      var title = card.querySelector(".cv2-party-name");
      if (title) {
        var badge = title.querySelector(".party-problem-badge");
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "party-problem-badge";
          title.appendChild(badge);
        }
        badge.textContent = String(problemCount);
        badge.classList.toggle("ok", problemCount === 0);
        badge.title = problemCount + " problema(s) relacionados a esta PT";
      }
    });

    renderPartySections(root, rows, parties, selectedParty);

    rawRows.forEach(function (row) {
      var x = rowData(row);
      var show = selectedParty == null || x.planned === Number(selectedParty) || x.actual === Number(selectedParty);
      setDisplay(row, show);
    });

    var tableBox = root.querySelector(".cv2-tablebox");
    if (tableBox) {
      var panel = tableBox.closest(".cv2-panel");
      var h3 = panel && panel.querySelector(".cv2-panel-head h3");
      var small = panel && panel.querySelector(".cv2-panel-head small");
      if (h3) h3.textContent = selectedParty == null ? "Tabela completa · TODAS AS PTS" : "Tabela completa · PT " + selectedParty;
      if (small) small.textContent = selectedParty == null ? "detalhes completos e equipamento" : "escalados ou detectados nesta PT";
    }

    filterAttention(root, rows, selectedParty);

    cards.forEach(function (card) {
      if (card.getAttribute("data-party-filter-bound-v2") === "1") return;
      card.setAttribute("data-party-filter-bound-v2", "1");
      card.addEventListener("click", function () {
        var p = Number(card.getAttribute("data-party-filter"));
        saveSelected(eventKey, p);
        apply();
      });
    });

    if (bar && bar.getAttribute("data-party-filter-bound-v2") !== "1") {
      bar.setAttribute("data-party-filter-bound-v2", "1");
      bar.addEventListener("click", function (ev) {
        var all = ev.target.closest("[data-party-filter-all]");
        var btn = ev.target.closest("[data-party-filter-button]");
        if (all) {
          saveSelected(eventKey, null);
          apply();
        } else if (btn) {
          saveSelected(eventKey, Number(btn.getAttribute("data-party-filter-button")));
          apply();
        }
      });
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(apply, 60);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  document.addEventListener("DOMContentLoaded", schedule);
  schedule();
})();
