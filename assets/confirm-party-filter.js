(function () {
  "use strict";

  var selectedParty = null;
  var selectedEvent = null;
  var scheduled = false;

  function norm(v) {
    return String(v || "").trim().toLowerCase();
  }

  function text(el) {
    return el ? String(el.textContent || "").trim() : "";
  }

  function setDisplay(el, show) {
    var next = show ? "" : "none";
    if (el && el.style.display !== next) el.style.display = next;
  }

  function playerNameFromRow(row) {
    var p = row && row.querySelector(".cv2-player");
    if (!p) return "";
    if (p.firstChild && p.firstChild.nodeType === 3) return String(p.firstChild.nodeValue || "").trim();
    return text(p).replace(/▦/g, "").trim();
  }

  function plannedPartyFromRow(row) {
    var cells = row ? row.querySelectorAll("td") : [];
    if (cells.length < 3) return null;
    var m = /PT\s+(\d+)/i.exec(text(cells[2]));
    return m ? Number(m[1]) : null;
  }

  function actualPartyFromRow(row) {
    var cells = row ? row.querySelectorAll("td") : [];
    if (cells.length < 4) return null;
    var m = /PT\s+(\d+)/i.exec(text(cells[3]));
    return m ? Number(m[1]) : null;
  }

  function stateFromRow(row) {
    var cells = row ? row.querySelectorAll("td") : [];
    return cells.length >= 7 ? text(cells[6]).toUpperCase() : "";
  }

  function discordFromRow(row) {
    var cells = row ? row.querySelectorAll("td") : [];
    return cells.length >= 5 && /NA CALL/i.test(text(cells[4]));
  }

  function isSeenInParty(row) {
    var cells = row ? row.querySelectorAll("td") : [];
    if (cells.length < 4) return false;
    return !/NÃO VISTO/i.test(text(cells[3]));
  }

  function currentEventKey(root) {
    var cta = root.querySelector(".cv2-head .cta");
    var m = /#(\d+)/.exec(text(cta));
    return m ? m[1] : text(cta);
  }

  function rowsForParty(rows, party) {
    if (party == null) return rows.slice();
    return rows.filter(function (row) {
      return plannedPartyFromRow(row) === Number(party);
    });
  }

  function updateKpis(root, visibleRows) {
    if (selectedParty == null) return;

    var total = visibleRows.length;
    var correct = 0;
    var wrong = 0;
    var missing = 0;
    var discord = 0;
    var detected = 0;

    visibleRows.forEach(function (row) {
      var planned = plannedPartyFromRow(row);
      var actual = actualPartyFromRow(row);
      var state = stateFromRow(row);

      if (planned != null && actual === planned) correct++;
      if (state.indexOf("PT ERRADA") >= 0) wrong++;
      if (!isSeenInParty(row)) missing++;
      if (discordFromRow(row)) discord++;
      if (isSeenInParty(row)) detected++;
    });

    var readiness = total ? Math.round(correct * 100 / total) : 0;
    var values = [
      [readiness + "%", correct + " de " + total + " inscritos na PT correta", readiness],
      [String(correct), "posição confirmada", total ? Math.round(correct * 100 / total) : 0],
      [String(wrong), "precisam trocar de PT", total ? Math.round(wrong * 100 / total) : 0],
      [String(missing), "sem party observada", total ? Math.round(missing * 100 / total) : 0],
      [String(discord), "presença na call de preparação", total ? Math.round(discord * 100 / total) : 0]
    ];

    var kpis = root.querySelectorAll(".cv2-kpi");
    values.forEach(function (v, i) {
      var card = kpis[i];
      if (!card) return;
      var value = card.querySelector(".v");
      var sub = card.querySelector(".s");
      var bar = card.querySelector(".cv2-minibar i");
      if (value && text(value) !== v[0]) value.textContent = v[0];
      if (sub && text(sub) !== v[1]) sub.textContent = v[1];
      if (bar) bar.style.width = Math.max(0, Math.min(100, v[2])) + "%";
    });

    var dist = root.querySelectorAll(".cv2-distitem");
    var residual = Math.max(0, total - correct - wrong - missing);
    [correct, wrong, missing, residual].forEach(function (v, i) {
      var b = dist[i] && dist[i].querySelector("b");
      if (b) b.textContent = String(v);
    });

    var segments = root.querySelectorAll(".cv2-segmentbar i");
    [correct, wrong, missing, residual].forEach(function (v, i) {
      if (segments[i]) segments[i].style.width = (total ? Math.round(v * 100 / total) : 0) + "%";
    });

    var indicators = root.querySelectorAll(".cv2-indicator");
    var indValues = [discord, detected, correct, wrong, missing];
    indValues.forEach(function (v, i) {
      var item = indicators[i];
      if (!item) return;
      var b = item.querySelector(".cv2-indicator-top b");
      var bar = item.querySelector(".cv2-indicator-bar i");
      if (b) b.textContent = String(v);
      if (bar) bar.style.width = (total ? Math.round(v * 100 / total) : 0) + "%";
    });
  }

  function updateTitles(root, count) {
    var label = selectedParty == null ? "TODAS AS PTS" : "PT " + selectedParty;

    var statusTitle = root.querySelector(".cv2-distribution") && root.querySelector(".cv2-distribution").closest(".cv2-panel");
    if (statusTitle) {
      var h = statusTitle.querySelector(".cv2-panel-head h3");
      var s = statusTitle.querySelector(".cv2-panel-head small");
      if (h) h.textContent = "Status de validação do CTA · " + label;
      if (s && selectedParty != null) s.textContent = count + " inscritos";
    }

    var tablePanel = root.querySelector(".cv2-tablebox");
    if (tablePanel) {
      var panel = tablePanel.closest(".cv2-panel");
      var h3 = panel && panel.querySelector(".cv2-panel-head h3");
      var small = panel && panel.querySelector(".cv2-panel-head small");
      if (h3) h3.textContent = "Jogadores inscritos · " + label;
      if (small && selectedParty != null) small.textContent = count + " inscritos · estado consolidado";
    }

    var danger = root.querySelector(".cv2-panel-head.danger");
    if (danger) {
      var dh = danger.querySelector("h3");
      if (dh) dh.textContent = "⚠ Precisa de atenção · " + label;
    }
  }

  function ensureStyle() {
    if (document.getElementById("confirm-party-filter-style")) return;
    var style = document.createElement("style");
    style.id = "confirm-party-filter-style";
    style.textContent =
      ".cv2-party{cursor:pointer;transition:opacity .12s ease,border-color .12s ease,box-shadow .12s ease,transform .12s ease}" +
      ".cv2-party:hover{transform:translateY(-1px);border-color:#4a6688}" +
      ".cv2-party.party-filter-selected{border-color:#4a97ff!important;box-shadow:0 0 0 1px rgba(74,151,255,.28) inset}" +
      ".cv2-party.party-filter-dim{opacity:.45}" +
      ".party-filterbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:10px 0 8px}" +
      ".party-filterbtn{border:1px solid #2b3a50;border-radius:8px;background:#101822;color:#93a3b8;padding:6px 10px;font:800 9px Inter,system-ui,sans-serif;cursor:pointer}" +
      ".party-filterbtn:hover{border-color:#53709a;color:#dbe7f5}" +
      ".party-filterbtn.on{border-color:#4a97ff;background:#16283c;color:#82bfff}" +
      ".party-filterhint{margin-left:auto;color:#8190a5;font-size:9px}" +
      ".party-problem-badge{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;margin-left:7px;border:1px solid #6b2a31;border-radius:999px;background:#2d1115;color:#ff8790;font-size:8px;font-weight:900;vertical-align:middle}" +
      ".party-problem-badge.ok{border-color:#25593b;background:#0d281a;color:#7fe3a4}";
    document.head.appendChild(style);
  }

  function apply() {
    scheduled = false;
    var root = document.getElementById("view-confirm");
    if (!root || !root.querySelector(".cv2-shell")) return;

    ensureStyle();

    var eventKey = currentEventKey(root);
    if (selectedEvent !== eventKey) {
      selectedEvent = eventKey;
      selectedParty = null;
    }

    var cards = Array.prototype.slice.call(root.querySelectorAll(".cv2-party"));
    var tableRows = Array.prototype.slice.call(root.querySelectorAll(".cv2-table tbody tr")).filter(function (r) {
      return r.querySelectorAll("td").length >= 7;
    });
    if (!cards.length || !tableRows.length) return;

    var playerParty = {};
    tableRows.forEach(function (row) {
      var name = playerNameFromRow(row);
      var party = plannedPartyFromRow(row);
      if (name && party != null) playerParty[norm(name)] = party;
    });

    var parties = [];
    cards.forEach(function (card) {
      var name = card.querySelector(".cv2-party-name");
      var m = /PT\s+(\d+)/i.exec(text(name));
      if (!m) return;
      var p = Number(m[1]);
      card.setAttribute("data-party-filter", String(p));
      if (parties.indexOf(p) < 0) parties.push(p);
    });
    parties.sort(function (a, b) { return a - b; });

    if (selectedParty != null && parties.indexOf(Number(selectedParty)) < 0) selectedParty = null;

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
        '<span class="party-filterhint">Clique em uma PT para isolar os problemas</span>';
      if (bar.innerHTML !== desired) bar.innerHTML = desired;
    }

    tableRows.forEach(function (row) {
      var show = selectedParty == null || plannedPartyFromRow(row) === Number(selectedParty);
      setDisplay(row, show);
    });

    var visibleRows = rowsForParty(tableRows, selectedParty);

    cards.forEach(function (card) {
      var p = Number(card.getAttribute("data-party-filter"));
      card.classList.toggle("party-filter-selected", selectedParty != null && p === Number(selectedParty));
      card.classList.toggle("party-filter-dim", selectedParty != null && p !== Number(selectedParty));

      var problemCount = tableRows.filter(function (row) {
        return plannedPartyFromRow(row) === p && stateFromRow(row) !== "PRONTO";
      }).length;

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
        badge.title = problemCount + " problema(s) nesta PT";
      }
    });

    var attention = Array.prototype.slice.call(root.querySelectorAll(".cv2-attention"));
    var visibleAttention = 0;
    attention.forEach(function (item) {
      var title = text(item.querySelector("b"));
      var ownerParty = null;

      Object.keys(playerParty).some(function (name) {
        if (norm(title).indexOf(name) === 0) {
          ownerParty = playerParty[name];
          return true;
        }
        return false;
      });

      if (ownerParty == null) {
        var detail = text(item.querySelector("small"));
        var mm = /deveria\s+PT\s+(\d+)/i.exec(detail) || /Escalado para\s+PT\s+(\d+)/i.exec(detail);
        if (mm) ownerParty = Number(mm[1]);
      }

      var show = selectedParty == null || ownerParty === Number(selectedParty);
      setDisplay(item, show);
      if (show) visibleAttention++;
    });

    var dangerHead = root.querySelector(".cv2-panel-head.danger");
    if (dangerHead) {
      var count = dangerHead.querySelector(".cv2-count");
      if (count) count.textContent = String(visibleAttention);
    }

    var emptyAttention = root.querySelector(".auditok");
    if (emptyAttention) {
      setDisplay(emptyAttention, selectedParty == null ? attention.length === 0 : visibleAttention === 0);
      if (selectedParty != null && visibleAttention === 0) emptyAttention.textContent = "✅ Nenhuma divergência crítica detectada nesta PT.";
    }

    updateTitles(root, visibleRows.length);
    updateKpis(root, visibleRows);

    cards.forEach(function (card) {
      if (card.getAttribute("data-party-filter-bound") === "1") return;
      card.setAttribute("data-party-filter-bound", "1");
      card.addEventListener("click", function () {
        var p = Number(card.getAttribute("data-party-filter"));
        selectedParty = selectedParty === p ? null : p;
        apply();
      });
    });

    if (bar && bar.getAttribute("data-party-filter-bound") !== "1") {
      bar.setAttribute("data-party-filter-bound", "1");
      bar.addEventListener("click", function (ev) {
        var all = ev.target.closest("[data-party-filter-all]");
        var btn = ev.target.closest("[data-party-filter-button]");
        if (all) {
          selectedParty = null;
          apply();
        } else if (btn) {
          selectedParty = Number(btn.getAttribute("data-party-filter-button"));
          apply();
        }
      });
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(apply, 50);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  document.addEventListener("DOMContentLoaded", schedule);
  schedule();
})();
