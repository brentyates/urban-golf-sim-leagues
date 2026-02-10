const TM_API = "https://api.trackmangolf.com/graphql";
const GG_BASE = "https://www.golfgenius.com";

const GG_SECTIONS = [
  { id: "12312864691629115220", name: "Overall Gross Stableford", type: "overall" },
  { id: "12396691282842404585", name: "Overall NET Stableford", type: "overall" },
  { id: "12396942319587215124", name: "R5 Emirates Net", type: "net" },
  { id: "12396943009231456021", name: "R5 Emirates Gross", type: "gross" },
  { id: "12396940865438795538", name: "R4 Clear Creek Net", type: "net" },
  { id: "12396941480827078419", name: "R4 Clear Creek Gross", type: "gross" },
  { id: "12396937201831692048", name: "R3 PGA West Net", type: "net" },
  { id: "12396937845271480081", name: "R3 PGA West Gross", type: "gross" },
  { id: "12396934600021034766", name: "R2 Turning Stone Net", type: "net" },
  { id: "12396935317448345359", name: "R2 Turning Stone Gross", type: "gross" },
  { id: "12396929683659212556", name: "R1 Hualalai Net", type: "net" },
  { id: "12396931156967212813", name: "R1 Hualalai Gross", type: "gross" },
];

const state = {
  tmTournament: null,
  tmLeaderboard: null,
  tmTeams: {},
  tmRounds: {},
  ggData: {},
  ggTeams: {},
  mapping: {},
  discrepancies: [],
  mulligans: [],
};

// ── Trackman ──

function makeNodeId(uuid) {
  return btoa(`OrderOfMeritTournament\nd${uuid}:Published`);
}

async function tmGql(query, variables) {
  const resp = await fetch(TM_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`Trackman API ${resp.status}`);
  const data = await resp.json();
  if (data.errors) {
    console.warn("GraphQL errors:", data.errors);
  }
  return data;
}

async function fetchTournamentInfo(nodeId) {
  const query = `
    query TournamentInfo($id: ID!) {
      node(id: $id) {
        ... on OrderOfMeritTournament {
          id
          name
          numberOfRounds
          startDate
          endDate
          isIndoor
          isTeam
          tournamentState
          teamSettings { size }
          rounds {
            id
            dbId
            roundNumber
            roundState
            startDate
            endDate
            numberOfHoles
            course { displayName }
            orderOfMeritScoring { ScoreMethod maxScore }
          }
        }
      }
    }`;
  const result = await tmGql(query, { id: nodeId });
  return result.data?.node || null;
}

async function fetchLeaderboard(nodeId) {
  const query = `
    query LeaderboardWithScorecards($id: ID!) {
      node(id: $id) {
        ... on OrderOfMeritTournament {
          leaderboard {
            records(take: 100) {
              totalCount
              items {
                playername
                teamId
                teamInfo {
                  name
                  members { playername }
                }
                total { pos posLabel score toPar }
                rounds {
                  roundNumber
                  score
                  toPar
                  thru
                  state
                  points
                  isCountingScore
                  scorecardId
                  scorecard {
                    grossScore
                    stablefordPoints
                    toPar
                    par
                    outScore
                    inScore
                    course { displayName }
                    holes {
                      holeNumber
                      par
                      grossScore
                      stablefordPoint
                      strokeIndex
                      mulligans
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;
  const result = await tmGql(query, { id: nodeId });
  return result.data?.node?.leaderboard || null;
}

function processTmData(leaderboard) {
  const items = leaderboard.records?.items || [];
  const teams = {};
  const rounds = {};

  for (const item of items) {
    const teamName = item.playername || "Unknown";
    const members = (item.teamInfo?.members || []).map(m => m.playername);
    teams[teamName] = { members, total: item.total, roundScores: {} };

    for (const r of item.rounds || []) {
      const rnum = r.roundNumber;
      const sc = r.scorecard;
      if (r.state !== "PLAYED" || !sc) continue;

      teams[teamName].roundScores[rnum] = {
        oomPoints: r.score,
        grossScore: sc.grossScore,
        stableford: sc.stablefordPoints,
        toPar: sc.toPar,
        out: sc.outScore,
        in: sc.inScore,
      };

      if (!rounds[rnum]) {
        rounds[rnum] = {
          course: sc.course?.displayName || "Unknown",
          teams: [],
        };
      }

      const holes = (sc.holes || [])
        .slice()
        .sort((a, b) => a.holeNumber - b.holeNumber)
        .map(h => ({
          hole: h.holeNumber,
          par: h.par,
          gross: h.grossScore,
          stableford: h.stablefordPoint,
          strokeIndex: h.strokeIndex,
          mulligans: h.mulligans || 0,
        }));

      rounds[rnum].teams.push({
        team: teamName,
        members,
        oomPoints: r.score,
        grossScore: sc.grossScore,
        stableford: sc.stablefordPoints,
        toPar: sc.toPar,
        out: sc.outScore,
        in: sc.inScore,
        holes,
      });
    }
  }

  return { teams, rounds };
}

function extractMulligans(rounds) {
  const mulligans = [];
  for (const [rnum, rdata] of Object.entries(rounds)) {
    for (const team of rdata.teams) {
      for (const hole of team.holes) {
        if (hole.mulligans > 0) {
          mulligans.push({
            round: parseInt(rnum),
            course: rdata.course,
            team: team.team,
            hole: hole.hole,
            count: hole.mulligans,
            par: hole.par,
            gross: hole.gross,
            stableford: hole.stableford,
          });
        }
      }
    }
  }
  return mulligans.sort((a, b) => a.round - b.round || a.team.localeCompare(b.team) || a.hole - b.hole);
}

// ── Golf Genius ──

async function fetchGGSection(eventId) {
  const url = `${GG_BASE}/v2tournaments/${eventId}?called_from=widgets/customized_tournament_results&hide_totals=false&player_stats_for_portal=true&round_index=1`;
  const resp = await fetch(url, {
    headers: {
      Accept: "text/html, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!resp.ok) throw new Error(`GG ${resp.status} for ${eventId}`);
  return resp.text();
}

function parseGGLeaderboard(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const rows = [];

  for (const table of doc.querySelectorAll("table")) {
    let headers = [];
    const headerRow = table.querySelector("tr.header, tr.thead");
    if (headerRow) {
      headers = Array.from(headerRow.querySelectorAll("td, th")).map(el => el.textContent.trim());
    } else {
      const theadThs = table.querySelectorAll("thead th");
      if (theadThs.length) {
        headers = Array.from(theadThs).map(el => el.textContent.trim());
      } else {
        const firstRow = table.querySelector("tr");
        if (firstRow) {
          headers = Array.from(firstRow.querySelectorAll("th, td")).map(el => el.textContent.trim());
        }
      }
    }

    for (const tr of table.querySelectorAll("tr.aggregate-row")) {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 2) continue;

      const row = {};
      cells.forEach((cell, j) => {
        const key = j < headers.length ? headers[j] : `col_${j}`;
        row[key] = cell.textContent.trim();
      });

      if (Object.values(row).some(v => v)) {
        rows.push(row);
      }
    }
  }

  return rows;
}

function roundFromName(name) {
  const m = name.match(/R(\d)/);
  return m ? parseInt(m[1]) : null;
}

function buildGGTeams(ggData) {
  const teams = {};
  for (const [name, section] of Object.entries(ggData)) {
    if (section.type !== "gross") continue;
    const rnum = roundFromName(name);
    if (!rnum) continue;

    for (const row of section.leaderboard) {
      const teamName = row.Player || row.player || row[""] || "";
      if (!teamName) continue;
      const pts = row["Stableford Points"] || row["Points"] || row["Pts"] || "";
      if (!teamName || pts === "-" || pts === "NS" || pts === "") continue;
      const val = parseInt(pts);
      if (isNaN(val)) continue;

      if (!teams[teamName]) teams[teamName] = {};
      teams[teamName][rnum] = val;
    }
  }
  return teams;
}

function buildGGNetTeams(ggData) {
  const teams = {};
  for (const [name, section] of Object.entries(ggData)) {
    if (section.type !== "net") continue;
    const rnum = roundFromName(name);
    if (!rnum) continue;

    for (const row of section.leaderboard) {
      const teamName = row.Player || row.player || row[""] || "";
      if (!teamName) continue;
      const pts = row["Stableford Points"] || row["Points"] || row["Pts"] || "";
      if (pts === "-" || pts === "NS" || pts === "") continue;
      const val = parseInt(pts);
      if (isNaN(val)) continue;

      if (!teams[teamName]) teams[teamName] = {};
      teams[teamName][rnum] = val;
    }
  }
  return teams;
}

// ── Team Matching ──

function scoreMatch(tmScores, ggScores) {
  let exact = 0, total = 0, totalDiff = 0;
  for (let rnum = 1; rnum <= 5; rnum++) {
    if (tmScores[rnum] !== undefined && ggScores[rnum] !== undefined) {
      total++;
      const diff = Math.abs(tmScores[rnum] - ggScores[rnum]);
      totalDiff += diff;
      if (diff === 0) exact++;
    }
  }
  return { exact, total, totalDiff };
}

function matchTeams(tmTeams, ggTeams) {
  const mapping = {};
  const usedGG = new Set();

  // Pass 1: exact matches across 3+ rounds
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    const tmScores = tmData.roundScores;
    if (Object.keys(tmScores).length < 3) continue;
    const tmStableford = {};
    for (const [r, s] of Object.entries(tmScores)) tmStableford[r] = s.stableford;

    let best = null, bestExact = 0, bestTotal = 0, bestDiff = 999;
    for (const [ggName, ggScores] of Object.entries(ggTeams)) {
      if (usedGG.has(ggName)) continue;
      const { exact, total, totalDiff } = scoreMatch(tmStableford, ggScores);
      if (total >= 3 && exact === total) {
        if (exact > bestExact || (exact === bestExact && total > bestTotal)) {
          best = ggName;
          bestExact = exact;
          bestTotal = total;
          bestDiff = totalDiff;
        }
      }
    }
    if (best && bestExact >= 3) {
      mapping[tmName] = { ggName: best, exact: bestExact, total: bestTotal, diff: bestDiff, pass: 1 };
      usedGG.add(best);
    }
  }

  // Pass 2: total diff <= 2 across 3+ rounds
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    if (mapping[tmName]) continue;
    const tmScores = tmData.roundScores;
    if (Object.keys(tmScores).length < 3) continue;
    const tmStableford = {};
    for (const [r, s] of Object.entries(tmScores)) tmStableford[r] = s.stableford;

    let best = null, bestExact = 0, bestTotal = 0, bestDiff = 999;
    for (const [ggName, ggScores] of Object.entries(ggTeams)) {
      if (usedGG.has(ggName)) continue;
      const { exact, total, totalDiff } = scoreMatch(tmStableford, ggScores);
      if (total >= 3 && totalDiff <= 2) {
        if (totalDiff < bestDiff || (totalDiff === bestDiff && exact > bestExact)) {
          best = ggName;
          bestExact = exact;
          bestTotal = total;
          bestDiff = totalDiff;
        }
      }
    }
    if (best) {
      mapping[tmName] = { ggName: best, exact: bestExact, total: bestTotal, diff: bestDiff, pass: 2 };
      usedGG.add(best);
    }
  }

  // Pass 3: fuzzy — 3+ rounds within 1pt each, total diff <= 5
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    if (mapping[tmName]) continue;
    const tmScores = tmData.roundScores;
    if (Object.keys(tmScores).length < 3) continue;
    const tmStableford = {};
    for (const [r, s] of Object.entries(tmScores)) tmStableford[r] = s.stableford;

    let best = null, bestClose = 0, bestDiff = 999;
    for (const [ggName, ggScores] of Object.entries(ggTeams)) {
      if (usedGG.has(ggName)) continue;
      let closeCount = 0, total = 0, totalDiff = 0;
      for (let rnum = 1; rnum <= 5; rnum++) {
        if (tmStableford[rnum] !== undefined && ggScores[rnum] !== undefined) {
          total++;
          const d = Math.abs(tmStableford[rnum] - ggScores[rnum]);
          totalDiff += d;
          if (d <= 1) closeCount++;
        }
      }
      if (total >= 3 && closeCount >= 3 && totalDiff <= 5) {
        if (closeCount > bestClose || (closeCount === bestClose && totalDiff < bestDiff)) {
          best = ggName;
          bestClose = closeCount;
          bestDiff = totalDiff;
        }
      }
    }
    if (best) {
      const { exact, total, totalDiff } = scoreMatch(tmStableford, ggTeams[best]);
      mapping[tmName] = { ggName: best, exact, total, diff: totalDiff, pass: 3 };
      usedGG.add(best);
    }
  }

  return { mapping, usedGG };
}

function findDiscrepancies(tmTeams, ggTeams, mapping) {
  const discrepancies = [];
  for (const [tmName, m] of Object.entries(mapping)) {
    const ggScores = ggTeams[m.ggName] || {};
    const tmScores = tmTeams[tmName]?.roundScores || {};
    for (let rnum = 1; rnum <= 5; rnum++) {
      const tmPts = tmScores[rnum]?.stableford;
      const ggPts = ggScores[rnum];
      if (tmPts !== undefined && ggPts !== undefined) {
        const diff = ggPts - tmPts;
        if (diff !== 0) {
          discrepancies.push({ tmName, ggName: m.ggName, round: rnum, tmScore: tmPts, ggScore: ggPts, diff });
        }
      }
    }
  }
  return discrepancies.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

// ── UI Rendering ──

function setStatus(msg, isError) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = isError ? "status error" : "status";
}

function initTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

function makeSortableTable(headers, rows, id) {
  let sortCol = null;
  let sortAsc = true;

  function render() {
    const sorted = [...rows];
    if (sortCol !== null) {
      sorted.sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        const an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return sortAsc ? an - bn : bn - an;
        return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
    }

    const table = document.createElement("table");
    table.id = id;
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headers.forEach((h, i) => {
      const th = document.createElement("th");
      th.textContent = h.label;
      if (sortCol === i) {
        const arrow = document.createElement("span");
        arrow.className = "sort-arrow";
        arrow.textContent = sortAsc ? " \u25B2" : " \u25BC";
        th.appendChild(arrow);
      }
      th.addEventListener("click", () => {
        if (sortCol === i) { sortAsc = !sortAsc; }
        else { sortCol = i; sortAsc = true; }
        render();
      });
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of sorted) {
      const tr = document.createElement("tr");
      row.forEach((val, i) => {
        const td = document.createElement("td");
        td.textContent = val ?? "";
        if (headers[i].cls) td.className = headers[i].cls;
        if (headers[i].clsFn) {
          const extra = headers[i].clsFn(val, row);
          if (extra) td.classList.add(extra);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    wrapper.appendChild(table);

    const container = document.getElementById(id)?.parentElement || document.getElementById(id + "-container");
    if (container) {
      const existing = container.querySelector(".table-wrapper");
      if (existing) existing.replaceWith(wrapper);
      else container.appendChild(wrapper);
    }
    return wrapper;
  }

  return render();
}

function renderTournamentInfo(tournament, tmRounds) {
  const el = document.getElementById("tournament-info");
  if (!tournament) { el.innerHTML = "<p>No Trackman data loaded.</p>"; return; }

  let html = `<div class="info-grid">
    <div class="info-card"><div class="label">Tournament</div><div class="value">${tournament.name}</div></div>
    <div class="info-card"><div class="label">State</div><div class="value">${tournament.tournamentState}</div></div>
    <div class="info-card"><div class="label">Rounds</div><div class="value">${tournament.numberOfRounds}</div></div>
    <div class="info-card"><div class="label">Team Size</div><div class="value">${tournament.teamSettings?.size || "?"}</div></div>
    <div class="info-card"><div class="label">Indoor</div><div class="value">${tournament.isIndoor ? "Yes" : "No"}</div></div>
  </div>`;

  html += "<h3>Rounds</h3><table><thead><tr><th>Round</th><th>Course</th><th>State</th><th>Holes</th><th>Scoring</th><th>Teams</th></tr></thead><tbody>";
  for (const r of tournament.rounds || []) {
    const teamCount = tmRounds[r.roundNumber]?.teams?.length || 0;
    html += `<tr>
      <td>R${r.roundNumber}</td>
      <td>${r.course?.displayName || "TBD"}</td>
      <td>${r.roundState}</td>
      <td class="num">${r.numberOfHoles}</td>
      <td>${r.orderOfMeritScoring?.ScoreMethod || "?"} (max ${r.orderOfMeritScoring?.maxScore || "?"})</td>
      <td class="num">${teamCount}</td>
    </tr>`;
  }
  html += "</tbody></table>";

  if (Object.keys(state.ggData).length) {
    html += "<h3>Golf Genius Sections</h3><table><thead><tr><th>Section</th><th>Type</th><th>Teams</th></tr></thead><tbody>";
    for (const [name, section] of Object.entries(state.ggData)) {
      html += `<tr><td>${name}</td><td>${section.type}</td><td class="num">${section.leaderboard.length}</td></tr>`;
    }
    html += "</tbody></table>";
  }

  el.innerHTML = html;
}

function renderLeaderboard() {
  const container = document.getElementById("leaderboard-view");
  container.innerHTML = "";

  const { tmTeams, ggTeams, mapping } = state;
  const ggNetTeams = state.ggNetTeams || {};
  if (!Object.keys(tmTeams).length) {
    container.innerHTML = "<p>Fetch data first.</p>";
    return;
  }

  const playedRounds = new Set();
  for (const t of Object.values(tmTeams)) {
    for (const r of Object.keys(t.roundScores)) playedRounds.add(parseInt(r));
  }
  const roundNums = [...playedRounds].sort((a, b) => a - b);

  const headers = [
    { label: "Pos" },
    { label: "Trackman Name" },
    { label: "GG Name" },
  ];
  for (const r of roundNums) {
    headers.push({ label: `R${r} Gross`, cls: "num" });
    headers.push({ label: `R${r} Net`, cls: "num" });
    headers.push({
      label: `R${r} HC`,
      cls: "num",
      clsFn: (v) => {
        const n = parseInt(v);
        if (isNaN(n)) return null;
        return n > 0 ? "diff-positive" : null;
      },
    });
  }
  headers.push({ label: "Total Gross", cls: "num" });
  headers.push({ label: "Total OOM Pts", cls: "num" });

  const rows = [];
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    const m = mapping[tmName];
    const ggName = m?.ggName || "";
    const ggNet = ggNetTeams[ggName] || {};
    const row = [
      tmData.total?.pos || "",
      tmName,
      ggName,
    ];

    let totalGross = 0;
    for (const r of roundNums) {
      const rs = tmData.roundScores[r];
      const gross = rs?.stableford ?? "";
      const net = ggNet[r] ?? "";
      const hc = (typeof gross === "number" && typeof net === "number") ? net - gross : "";
      row.push(gross, net, hc);
      if (typeof gross === "number") totalGross += gross;
    }

    row.push(totalGross || "");
    row.push(tmData.total?.score ?? "");
    rows.push(row);
  }

  rows.sort((a, b) => {
    const ap = parseInt(a[0]) || 999, bp = parseInt(b[0]) || 999;
    return ap - bp;
  });

  const div = document.createElement("div");
  div.id = "leaderboard-table-container";
  container.appendChild(div);
  const wrapper = makeSortableTable(headers, rows, "leaderboard-table");
  div.appendChild(wrapper);
}

function renderMapping() {
  const container = document.getElementById("mapping-view");
  container.innerHTML = "";

  const { mapping, tmTeams, ggTeams } = state;
  if (!Object.keys(mapping).length) {
    container.innerHTML = "<p>Run team matching first (fetch both sources).</p>";
    return;
  }

  const passLabels = { 1: "Exact", 2: "Near (d\u22642)", 3: "Fuzzy" };
  const passCls = { 1: "match-exact", 2: "match-near", 3: "match-fuzzy" };

  const stats = { 1: 0, 2: 0, 3: 0 };
  for (const m of Object.values(mapping)) stats[m.pass]++;

  let summaryHtml = "<div style='margin-bottom:0.5rem'>";
  summaryHtml += `<span class="summary-stat">Total: ${Object.keys(mapping).length}</span>`;
  for (const [p, label] of Object.entries(passLabels)) {
    summaryHtml += `<span class="summary-stat">${label}: ${stats[p] || 0}</span>`;
  }
  const unmatchedTm = Object.keys(tmTeams).filter(t => !mapping[t]);
  const usedGG = new Set(Object.values(mapping).map(m => m.ggName));
  const unmatchedGG = Object.keys(ggTeams).filter(t => !usedGG.has(t));
  summaryHtml += `<span class="summary-stat">Unmatched TM: ${unmatchedTm.length}</span>`;
  summaryHtml += `<span class="summary-stat">Unmatched GG: ${unmatchedGG.length}</span>`;
  summaryHtml += "</div>";
  container.insertAdjacentHTML("beforeend", summaryHtml);

  const headers = [
    { label: "Trackman Name" },
    { label: "Golf Genius Name" },
    { label: "Match Type", clsFn: (v) => v === "Exact" ? "match-exact" : v.startsWith("Near") ? "match-near" : "match-fuzzy" },
    { label: "Exact Rounds", cls: "num" },
    { label: "Compared Rounds", cls: "num" },
    { label: "Total Diff", cls: "num" },
  ];

  const rows = Object.entries(mapping)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tmName, m]) => [
      tmName,
      m.ggName,
      passLabels[m.pass],
      m.exact,
      m.total,
      m.diff,
    ]);

  const div = document.createElement("div");
  div.id = "mapping-table-container";
  container.appendChild(div);
  div.appendChild(makeSortableTable(headers, rows, "mapping-table"));

  if (unmatchedTm.length) {
    let html = `<h3 style="margin-top:1rem">Unmatched Trackman Teams (${unmatchedTm.length})</h3><table><thead><tr><th>Team</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th></tr></thead><tbody>`;
    for (const t of unmatchedTm.sort()) {
      html += `<tr><td>${t}</td>`;
      for (let r = 1; r <= 5; r++) html += `<td class="num">${tmTeams[t]?.roundScores[r]?.stableford ?? "-"}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table>";
    container.insertAdjacentHTML("beforeend", html);
  }

  if (unmatchedGG.length) {
    let html = `<h3 style="margin-top:1rem">Unmatched Golf Genius Teams (${unmatchedGG.length})</h3><table><thead><tr><th>Team</th><th>R1</th><th>R2</th><th>R3</th><th>R4</th><th>R5</th></tr></thead><tbody>`;
    for (const t of unmatchedGG.sort()) {
      html += `<tr><td>${t}</td>`;
      for (let r = 1; r <= 5; r++) html += `<td class="num">${ggTeams[t]?.[r] ?? "-"}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table>";
    container.insertAdjacentHTML("beforeend", html);
  }
}

function renderDiscrepancies() {
  const container = document.getElementById("discrepancies-view");
  container.innerHTML = "";

  const { discrepancies } = state;
  if (!discrepancies.length) {
    container.innerHTML = "<p>No discrepancies found (or data not loaded).</p>";
    return;
  }

  const byRound = {};
  for (const d of discrepancies) {
    if (!byRound[d.round]) byRound[d.round] = [];
    byRound[d.round].push(d);
  }

  let summaryHtml = "<div style='margin-bottom:0.75rem'>";
  summaryHtml += `<span class="summary-stat">Total: ${discrepancies.length}</span>`;
  for (const [rnum, diffs] of Object.entries(byRound).sort(([a], [b]) => a - b)) {
    const avg = diffs.reduce((s, d) => s + d.diff, 0) / diffs.length;
    summaryHtml += `<span class="summary-stat">R${rnum}: ${diffs.length} (avg ${avg >= 0 ? "+" : ""}${avg.toFixed(1)})</span>`;
  }
  const positive = discrepancies.filter(d => d.diff > 0).length;
  const negative = discrepancies.filter(d => d.diff < 0).length;
  summaryHtml += `<span class="summary-stat">GG > TM: ${positive}</span>`;
  summaryHtml += `<span class="summary-stat">GG < TM: ${negative}</span>`;
  summaryHtml += "</div>";
  container.insertAdjacentHTML("beforeend", summaryHtml);

  const headers = [
    { label: "Trackman Team" },
    { label: "GG Team" },
    { label: "Round", cls: "num" },
    { label: "TM Score", cls: "num" },
    { label: "GG Score", cls: "num" },
    { label: "Diff", cls: "num", clsFn: (v) => {
      const n = parseInt(v);
      if (isNaN(n)) return null;
      return n > 0 ? "diff-positive" : n < 0 ? "diff-negative" : null;
    }},
  ];

  const rows = discrepancies.map(d => [
    d.tmName, d.ggName, `R${d.round}`, d.tmScore, d.ggScore, (d.diff > 0 ? "+" : "") + d.diff,
  ]);

  const div = document.createElement("div");
  div.id = "discrepancies-table-container";
  container.appendChild(div);
  div.appendChild(makeSortableTable(headers, rows, "discrepancies-table"));
}

function renderMulligans() {
  const container = document.getElementById("mulligans-view");
  container.innerHTML = "";

  const { mulligans } = state;
  if (!mulligans.length) {
    container.innerHTML = "<p>No mulligans found (or Trackman data not loaded).</p>";
    return;
  }

  const totalUses = mulligans.reduce((s, m) => s + m.count, 0);
  const uniqueTeams = new Set(mulligans.map(m => m.team)).size;
  const byRound = {};
  for (const m of mulligans) {
    if (!byRound[m.round]) byRound[m.round] = 0;
    byRound[m.round] += m.count;
  }

  let summaryHtml = "<div style='margin-bottom:0.75rem'>";
  summaryHtml += `<span class="summary-stat">Total uses: ${totalUses}</span>`;
  summaryHtml += `<span class="summary-stat">Teams: ${uniqueTeams}</span>`;
  for (const [r, count] of Object.entries(byRound).sort(([a], [b]) => a - b)) {
    summaryHtml += `<span class="summary-stat">R${r}: ${count}</span>`;
  }
  summaryHtml += "</div>";
  container.insertAdjacentHTML("beforeend", summaryHtml);

  const headers = [
    { label: "Round", cls: "num" },
    { label: "Course" },
    { label: "Team" },
    { label: "Hole", cls: "num" },
    { label: "Count", cls: "num" },
    { label: "Par", cls: "num" },
    { label: "Gross", cls: "num" },
    { label: "Stableford Pts", cls: "num" },
  ];

  const rows = mulligans.map(m => [
    `R${m.round}`, m.course, m.team, m.hole, m.count, m.par, m.gross, m.stableford,
  ]);

  const div = document.createElement("div");
  div.id = "mulligans-table-container";
  container.appendChild(div);
  div.appendChild(makeSortableTable(headers, rows, "mulligans-table"));
}

function renderHoleByHole() {
  const container = document.getElementById("hole-by-hole-view");
  container.innerHTML = "";

  const { tmRounds } = state;
  if (!Object.keys(tmRounds).length) {
    container.innerHTML = "<p>No Trackman data loaded.</p>";
    return;
  }

  const filterHtml = `<div class="filter-bar">
    <select id="hbh-round">
      ${Object.keys(tmRounds).sort((a, b) => a - b).map(r =>
        `<option value="${r}">Round ${r} - ${tmRounds[r].course}</option>`
      ).join("")}
    </select>
    <input type="text" id="hbh-search" placeholder="Filter by team name...">
  </div>`;
  container.insertAdjacentHTML("beforeend", filterHtml);

  const tableDiv = document.createElement("div");
  tableDiv.id = "hbh-table-area";
  container.appendChild(tableDiv);

  function renderRound() {
    const rnum = document.getElementById("hbh-round").value;
    const search = document.getElementById("hbh-search").value.toLowerCase();
    const rdata = tmRounds[rnum];
    if (!rdata) return;

    tableDiv.innerHTML = "";

    const headers = [{ label: "Team" }];
    for (let h = 1; h <= 9; h++) headers.push({ label: String(h), cls: "num" });
    headers.push({ label: "Out", cls: "num" });
    for (let h = 10; h <= 18; h++) headers.push({ label: String(h), cls: "num" });
    headers.push({ label: "In", cls: "num" });
    headers.push({ label: "Gross", cls: "num" });
    headers.push({ label: "Stableford", cls: "num" });

    let teams = rdata.teams;
    if (search) teams = teams.filter(t => t.team.toLowerCase().includes(search));

    const rows = teams.map(t => {
      const row = [t.team];
      let out = 0, inn = 0;
      for (let h = 1; h <= 18; h++) {
        const hole = t.holes.find(x => x.hole === h);
        const val = hole?.gross ?? "";
        if (h <= 9 && typeof val === "number") out += val;
        if (h > 9 && typeof val === "number") inn += val;
        row.push(val);
        if (h === 9) row.push(out || "");
      }
      row.push(inn || "");
      row.push(t.grossScore ?? "");
      row.push(t.stableford ?? "");
      return row;
    });

    const wrapper = document.createElement("div");
    wrapper.className = "table-wrapper";
    const table = document.createElement("table");

    const parRow = document.createElement("tr");
    parRow.innerHTML = "<td><strong>Par</strong></td>";
    const firstTeam = rdata.teams[0];
    if (firstTeam) {
      let parOut = 0, parIn = 0;
      for (let h = 1; h <= 18; h++) {
        const hole = firstTeam.holes.find(x => x.hole === h);
        const p = hole?.par ?? "";
        if (h <= 9 && typeof p === "number") parOut += p;
        if (h > 9 && typeof p === "number") parIn += p;
        parRow.innerHTML += `<td class="num"><strong>${p}</strong></td>`;
        if (h === 9) parRow.innerHTML += `<td class="num"><strong>${parOut || ""}</strong></td>`;
      }
      parRow.innerHTML += `<td class="num"><strong>${parIn || ""}</strong></td>`;
      parRow.innerHTML += `<td class="num"><strong>${(parOut + parIn) || ""}</strong></td>`;
      parRow.innerHTML += "<td></td>";
    }

    const thead = document.createElement("thead");
    const headerTr = document.createElement("tr");
    headers.forEach(h => {
      const th = document.createElement("th");
      th.textContent = h.label;
      headerTr.appendChild(th);
    });
    thead.appendChild(headerTr);
    thead.appendChild(parRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      row.forEach((val, i) => {
        const td = document.createElement("td");
        td.textContent = val ?? "";
        if (headers[i]?.cls) td.className = headers[i].cls;

        // Highlight mulligan holes
        // Columns: 0=Team, 1-9=Holes 1-9, 10=Out, 11-19=Holes 10-18, 20=In, 21=Gross, 22=Stableford
        let hNum = null;
        if (i >= 1 && i <= 9) hNum = i;
        else if (i >= 11 && i <= 19) hNum = i - 1;
        if (hNum) {
          const team = rdata.teams.find(t => t.team === row[0]);
          const hole = team?.holes.find(x => x.hole === hNum);
          if (hole?.mulligans > 0) td.classList.add("mulligan");
        }

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    tableDiv.appendChild(wrapper);
  }

  document.getElementById("hbh-round").addEventListener("change", renderRound);
  document.getElementById("hbh-search").addEventListener("input", renderRound);
  renderRound();
}

// ── Excel Export ──

function exportToExcel() {
  if (typeof XLSX === "undefined") {
    alert("SheetJS not loaded. Check your internet connection.");
    return;
  }

  const wb = XLSX.utils.book_new();

  // Sheet 1: Leaderboard
  const { tmTeams, mapping, ggTeams } = state;
  const ggNetTeams = state.ggNetTeams || {};
  const playedRounds = new Set();
  for (const t of Object.values(tmTeams)) {
    for (const r of Object.keys(t.roundScores)) playedRounds.add(parseInt(r));
  }
  const roundNums = [...playedRounds].sort((a, b) => a - b);

  const lbHeaders = ["Pos", "Trackman Name", "GG Name"];
  for (const r of roundNums) {
    lbHeaders.push(`R${r} Gross`, `R${r} Net`, `R${r} HC Benefit`);
  }
  lbHeaders.push("Total Gross", "Total OOM Pts");

  const lbRows = [lbHeaders];
  const entries = Object.entries(tmTeams).sort((a, b) => {
    const ap = a[1].total?.pos || 999, bp = b[1].total?.pos || 999;
    return ap - bp;
  });
  for (const [tmName, tmData] of entries) {
    const m = mapping[tmName];
    const ggName = m?.ggName || "";
    const ggNet = ggNetTeams[ggName] || {};
    const row = [tmData.total?.pos || "", tmName, ggName];
    let totalGross = 0;
    for (const r of roundNums) {
      const rs = tmData.roundScores[r];
      const gross = rs?.stableford ?? "";
      const net = ggNet[r] ?? "";
      const hc = (typeof gross === "number" && typeof net === "number") ? net - gross : "";
      row.push(gross, net, hc);
      if (typeof gross === "number") totalGross += gross;
    }
    row.push(totalGross || "", tmData.total?.score ?? "");
    lbRows.push(row);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lbRows), "Leaderboard");

  // Sheet 2: Team Mapping
  const mapRows = [["Trackman Name", "Golf Genius Name", "Match Type", "Exact Rounds", "Compared Rounds", "Total Diff"]];
  const passLabels = { 1: "Exact", 2: "Near", 3: "Fuzzy" };
  for (const [tmName, m] of Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))) {
    mapRows.push([tmName, m.ggName, passLabels[m.pass], m.exact, m.total, m.diff]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mapRows), "Team Mapping");

  // Sheet 3: Discrepancies
  const discRows = [["Trackman Team", "GG Team", "Round", "TM Score", "GG Score", "Diff"]];
  for (const d of state.discrepancies) {
    discRows.push([d.tmName, d.ggName, `R${d.round}`, d.tmScore, d.ggScore, d.diff]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(discRows), "Discrepancies");

  // Sheet 4: Mulligans
  const mulRows = [["Round", "Course", "Team", "Hole", "Count", "Par", "Gross", "Stableford Pts"]];
  for (const m of state.mulligans) {
    mulRows.push([`R${m.round}`, m.course, m.team, m.hole, m.count, m.par, m.gross, m.stableford]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mulRows), "Mulligans");

  // Sheet 5: Hole-by-Hole (flat table, all rounds)
  const hbhHeaders = ["Round", "Course", "Team"];
  for (let h = 1; h <= 9; h++) hbhHeaders.push(String(h));
  hbhHeaders.push("Out");
  for (let h = 10; h <= 18; h++) hbhHeaders.push(String(h));
  hbhHeaders.push("In", "Gross", "Stableford");
  const hbhRows = [hbhHeaders];

  for (const [rnum, rdata] of Object.entries(state.tmRounds).sort(([a], [b]) => a - b)) {
    for (const t of rdata.teams) {
      const row = [`R${rnum}`, rdata.course, t.team];
      for (let h = 1; h <= 18; h++) {
        const hole = t.holes.find(x => x.hole === h);
        row.push(hole?.gross ?? "");
        if (h === 9) row.push(t.out ?? "");
      }
      row.push(t.in ?? "");
      row.push(t.grossScore ?? "");
      row.push(t.stableford ?? "");
      hbhRows.push(row);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hbhRows), "Hole-by-Hole");

  XLSX.writeFile(wb, "winter_league_data.xlsx");
}

// ── GG Section Config UI ──

function initGGSections() {
  const container = document.getElementById("gg-sections");
  let html = "";
  for (const section of GG_SECTIONS) {
    html += `<div class="gg-section-row">
      <span>${section.name}</span>
      <input type="text" data-gg-name="${section.name}" data-gg-type="${section.type}" value="${section.id}">
    </div>`;
  }
  container.innerHTML = html;
}

function getGGSectionsFromUI() {
  const sections = [];
  document.querySelectorAll("#gg-sections input").forEach(input => {
    const id = input.value.trim();
    if (id) {
      sections.push({
        id,
        name: input.dataset.ggName,
        type: input.dataset.ggType,
      });
    }
  });
  return sections;
}

// ── Main Flow ──

async function fetchTrackman() {
  const uuid = document.getElementById("tm-uuid").value.trim();
  if (!uuid) throw new Error("Trackman UUID required");

  setStatus("Fetching Trackman tournament info...");
  const nodeId = makeNodeId(uuid);
  const tournament = await fetchTournamentInfo(nodeId);
  if (!tournament) throw new Error("Failed to fetch tournament info");
  state.tmTournament = tournament;

  setStatus("Fetching Trackman leaderboard + scorecards...");
  const leaderboard = await fetchLeaderboard(nodeId);
  if (!leaderboard) throw new Error("Failed to fetch leaderboard");
  state.tmLeaderboard = leaderboard;

  const { teams, rounds } = processTmData(leaderboard);
  state.tmTeams = teams;
  state.tmRounds = rounds;
  state.mulligans = extractMulligans(rounds);

  setStatus(`Trackman: ${Object.keys(teams).length} teams, ${Object.keys(rounds).length} rounds`);
}

async function fetchGolfGenius() {
  const sections = getGGSectionsFromUI();
  if (!sections.length) throw new Error("No GG sections configured");

  const ggData = {};
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    setStatus(`Fetching GG: ${section.name} (${i + 1}/${sections.length})...`);
    try {
      const html = await fetchGGSection(section.id);
      const leaderboard = parseGGLeaderboard(html);
      ggData[section.name] = { type: section.type, leaderboard };
    } catch (err) {
      console.warn(`GG fetch failed for ${section.name}:`, err);
      ggData[section.name] = { type: section.type, leaderboard: [], error: err.message };
    }
  }

  state.ggData = ggData;
  state.ggTeams = buildGGTeams(ggData);
  state.ggNetTeams = buildGGNetTeams(ggData);
  setStatus(`GG: ${Object.keys(state.ggTeams).length} gross teams loaded`);
}

function runMatching() {
  if (!Object.keys(state.tmTeams).length || !Object.keys(state.ggTeams).length) return;

  setStatus("Matching teams...");
  const { mapping } = matchTeams(state.tmTeams, state.ggTeams);
  state.mapping = mapping;
  state.discrepancies = findDiscrepancies(state.tmTeams, state.ggTeams, mapping);
  setStatus(`Matched ${Object.keys(mapping).length} teams, ${state.discrepancies.length} discrepancies`);
}

function renderAll() {
  document.getElementById("results").classList.remove("hidden");
  document.getElementById("export-panel").classList.remove("hidden");
  renderTournamentInfo(state.tmTournament, state.tmRounds);
  renderLeaderboard();
  renderMapping();
  renderDiscrepancies();
  renderMulligans();
  renderHoleByHole();
}

async function fetchAll() {
  const btn = document.getElementById("btn-fetch-all");
  btn.disabled = true;
  try {
    await fetchTrackman();
    await fetchGolfGenius();
    runMatching();
    renderAll();
    setStatus("Done.");
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

async function fetchTmOnly() {
  try {
    await fetchTrackman();
    if (Object.keys(state.ggTeams).length) runMatching();
    renderAll();
    setStatus("Trackman data loaded.");
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    console.error(err);
  }
}

async function fetchGgOnly() {
  try {
    await fetchGolfGenius();
    if (Object.keys(state.tmTeams).length) runMatching();
    renderAll();
    setStatus("Golf Genius data loaded.");
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    console.error(err);
  }
}

// ── Init ──

initTabs();
initGGSections();
document.getElementById("btn-fetch-all").addEventListener("click", fetchAll);
document.getElementById("btn-fetch-tm").addEventListener("click", fetchTmOnly);
document.getElementById("btn-fetch-gg").addEventListener("click", fetchGgOnly);
document.getElementById("btn-export").addEventListener("click", exportToExcel);
