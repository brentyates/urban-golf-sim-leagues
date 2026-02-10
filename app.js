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
  const allRounds = new Set([...Object.keys(tmScores), ...Object.keys(ggScores)].map(Number));
  for (const rnum of allRounds) {
    if (tmScores[rnum] !== undefined && ggScores[rnum] !== undefined) {
      total++;
      const diff = Math.abs(tmScores[rnum] - ggScores[rnum]);
      totalDiff += diff;
      if (diff === 0) exact++;
    }
  }
  return { exact, total, totalDiff };
}

function nameTokens(name) {
  return name
    .toLowerCase()
    .split(/[\s\/,.\-_]+/)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t));
}

function nameSimilarity(tmName, ggName) {
  const tmToks = nameTokens(tmName);
  const ggToks = nameTokens(ggName);
  if (!tmToks.length || !ggToks.length) return 0;

  let shared = 0;
  const ggUsed = new Set();
  for (const tt of tmToks) {
    for (const gt of ggToks) {
      if (ggUsed.has(gt)) continue;
      if (tt === gt || tt.includes(gt) || gt.includes(tt)) {
        shared++;
        ggUsed.add(gt);
        break;
      }
    }
  }

  const union = new Set([...tmToks, ...ggToks]).size;
  return shared / union;
}

function getTmStableford(tmData) {
  const s = {};
  for (const [r, scores] of Object.entries(tmData.roundScores)) s[r] = scores.stableford;
  return s;
}

function matchTeams(tmTeams, ggTeams) {
  const mapping = {};
  const usedGG = new Set();

  // Pass 1: exact score matches across 3+ rounds
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    if (Object.keys(tmData.roundScores).length < 3) continue;
    const tmStableford = getTmStableford(tmData);

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

  // Pass 2: near score match (total diff <= 2) across 3+ rounds
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    if (mapping[tmName]) continue;
    if (Object.keys(tmData.roundScores).length < 3) continue;
    const tmStableford = getTmStableford(tmData);

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

  // Pass 3: fuzzy score — 3+ rounds within 1pt each, total diff <= 5
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    if (mapping[tmName]) continue;
    if (Object.keys(tmData.roundScores).length < 3) continue;
    const tmStableford = getTmStableford(tmData);

    let best = null, bestClose = 0, bestDiff = 999;
    for (const [ggName, ggScores] of Object.entries(ggTeams)) {
      if (usedGG.has(ggName)) continue;
      let closeCount = 0, total = 0, totalDiff = 0;
      const allRounds = new Set([...Object.keys(tmStableford), ...Object.keys(ggScores)].map(Number));
      for (const rnum of allRounds) {
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

  // Pass 4: combined name + score — for remaining unmatched, use name similarity
  // weighted with whatever score evidence exists (works even with 1 round)
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    if (mapping[tmName]) continue;
    const tmStableford = getTmStableford(tmData);

    let best = null, bestScore = 0;
    for (const [ggName, ggScores] of Object.entries(ggTeams)) {
      if (usedGG.has(ggName)) continue;

      const nSim = nameSimilarity(tmName, ggName);
      const { exact, total, totalDiff } = scoreMatch(tmStableford, ggScores);

      // Score similarity: 1.0 when all match, decreasing with diff
      // Average diff per round, scaled so 0 diff = 1.0 and 5+ avg diff = 0
      const scoreSim = total > 0 ? Math.max(0, 1 - (totalDiff / total) / 5) : 0;

      // Combined: name and score reinforce each other
      // Strong name match can compensate for score gaps and vice versa
      const combined = (nSim * 0.5) + (scoreSim * 0.3) + (nSim * scoreSim * 0.2);

      if (combined > bestScore) {
        bestScore = combined;
        best = { ggName, exact, total, totalDiff, nSim, scoreSim };
      }
    }

    // Require meaningful evidence: decent name match, or name + some score agreement
    if (best && bestScore >= 0.3 && (best.nSim >= 0.25 || best.total >= 1)) {
      mapping[tmName] = {
        ggName: best.ggName,
        exact: best.exact,
        total: best.total,
        diff: best.totalDiff,
        pass: 4,
        nameSim: best.nSim,
      };
      usedGG.add(best.ggName);
    }
  }

  return { mapping, usedGG };
}

function findDiscrepancies(tmTeams, ggTeams, mapping) {
  const discrepancies = [];
  for (const [tmName, m] of Object.entries(mapping)) {
    const ggScores = ggTeams[m.ggName] || {};
    const tmScores = tmTeams[tmName]?.roundScores || {};
    const allRounds = new Set([...Object.keys(tmScores), ...Object.keys(ggScores)].map(Number));
    for (const rnum of allRounds) {
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
      const hc = (typeof gross === "number" && typeof net === "number") ? gross - net : "";
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

  const passLabels = { 1: "Exact", 2: "Near (d\u22642)", 3: "Fuzzy", 4: "Name+Score" };
  const passCls = { 1: "match-exact", 2: "match-near", 3: "match-fuzzy", 4: "match-fuzzy" };

  const stats = { 1: 0, 2: 0, 3: 0, 4: 0 };
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
    { label: "Match Type", clsFn: (v) => v === "Exact" ? "match-exact" : v.startsWith("Near") ? "match-near" : v === "Fuzzy" || v === "Name+Score" ? "match-fuzzy" : null },
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

// ── HC Trends ──

function getTeamHCData() {
  const { tmTeams, mapping } = state;
  const ggNetTeams = state.ggNetTeams || {};

  const playedRounds = new Set();
  for (const t of Object.values(tmTeams)) {
    for (const r of Object.keys(t.roundScores)) playedRounds.add(parseInt(r));
  }
  const roundNums = [...playedRounds].sort((a, b) => a - b);

  const teams = [];
  for (const [tmName, tmData] of Object.entries(tmTeams)) {
    const m = mapping[tmName];
    const ggName = m?.ggName || "";
    const ggNet = ggNetTeams[ggName] || {};

    const hcByRound = {};
    const grossByRound = {};
    const netByRound = {};
    for (const r of roundNums) {
      const gross = tmData.roundScores[r]?.stableford;
      const net = ggNet[r];
      grossByRound[r] = gross;
      netByRound[r] = net;
      if (typeof gross === "number" && typeof net === "number") {
        hcByRound[r] = gross - net;
      }
    }

    const hcValues = Object.values(hcByRound).filter(v => typeof v === "number");
    if (!hcValues.length) continue;

    teams.push({
      tmName,
      ggName,
      pos: tmData.total?.pos || 999,
      hcByRound,
      grossByRound,
      netByRound,
      avgHC: hcValues.reduce((s, v) => s + v, 0) / hcValues.length,
      minHC: Math.min(...hcValues),
      maxHC: Math.max(...hcValues),
    });
  }

  return { teams: teams.sort((a, b) => a.pos - b.pos), roundNums };
}

function svgSparkline(hcByRound, roundNums, width, height, color) {
  const values = roundNums.map(r => hcByRound[r]);
  const defined = values.filter(v => typeof v === "number");
  if (defined.length < 2) {
    const y = height / 2;
    const cx = width / 2;
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <circle cx="${cx}" cy="${y}" r="3" fill="${color}"/>
    </svg>`;
  }

  const allHCs = Object.values(state.tmTeams).flatMap(t => {
    const ggName = state.mapping[t.total?.pos ? Object.keys(state.tmTeams).find(n => state.tmTeams[n] === t) : ""]?.ggName;
    return [];
  });

  const min = Math.min(...defined) - 1;
  const max = Math.max(...defined) + 1;
  const range = max - min || 1;
  const pad = 4;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const points = [];
  const dots = [];
  const step = roundNums.length > 1 ? innerW / (roundNums.length - 1) : 0;

  roundNums.forEach((r, i) => {
    const v = hcByRound[r];
    if (typeof v !== "number") return;
    const x = pad + i * step;
    const y = pad + innerH - ((v - min) / range) * innerH;
    points.push(`${x},${y}`);
    dots.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="${color}"/>`);
  });

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${dots.join("")}
  </svg>`;
}

function svgDetailChart(teamData, roundNums) {
  const W = 500, H = 200, pad = { top: 20, right: 20, bottom: 30, left: 40 };
  const iW = W - pad.left - pad.right;
  const iH = H - pad.top - pad.bottom;

  const allVals = [];
  for (const r of roundNums) {
    if (typeof teamData.grossByRound[r] === "number") allVals.push(teamData.grossByRound[r]);
    if (typeof teamData.netByRound[r] === "number") allVals.push(teamData.netByRound[r]);
  }
  if (!allVals.length) return "";

  const min = Math.min(...allVals) - 2;
  const max = Math.max(...allVals) + 2;
  const range = max - min || 1;

  function x(i) { return pad.left + (roundNums.length > 1 ? (i / (roundNums.length - 1)) * iW : iW / 2); }
  function y(v) { return pad.top + iH - ((v - min) / range) * iH; }

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="font-family:sans-serif">`;

  // Grid lines
  const gridSteps = 5;
  for (let i = 0; i <= gridSteps; i++) {
    const val = min + (range * i / gridSteps);
    const gy = y(val);
    svg += `<line x1="${pad.left}" y1="${gy}" x2="${W - pad.right}" y2="${gy}" stroke="#e2e8f0" stroke-width="1"/>`;
    svg += `<text x="${pad.left - 6}" y="${gy + 3}" text-anchor="end" font-size="10" fill="#94a3b8">${Math.round(val)}</text>`;
  }

  // X-axis labels
  roundNums.forEach((r, i) => {
    svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#64748b">R${r}</text>`;
  });

  // HC fill area
  const hcPoints = [];
  roundNums.forEach((r, i) => {
    const g = teamData.grossByRound[r];
    const n = teamData.netByRound[r];
    if (typeof g === "number" && typeof n === "number") {
      hcPoints.push({ i, gy: y(g), ny: y(n), x: x(i) });
    }
  });
  if (hcPoints.length >= 2) {
    const topPath = hcPoints.map(p => `${p.x},${p.ny}`).join(" ");
    const botPath = hcPoints.slice().reverse().map(p => `${p.x},${p.gy}`).join(" ");
    svg += `<polygon points="${topPath} ${botPath}" fill="#2563eb" opacity="0.12"/>`;
  }

  // Lines: gross, net
  function line(getData, color) {
    const pts = [];
    const dots = [];
    roundNums.forEach((r, i) => {
      const v = getData(r);
      if (typeof v !== "number") return;
      const px = x(i), py = y(v);
      pts.push(`${px},${py}`);
      dots.push(`<circle cx="${px}" cy="${py}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
    });
    if (pts.length < 2) return dots.join("");
    return `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>` + dots.join("");
  }

  svg += line(r => teamData.grossByRound[r], "#16a34a");
  svg += line(r => teamData.netByRound[r], "#ea580c");

  // HC value labels between lines
  roundNums.forEach((r, i) => {
    const hc = teamData.hcByRound[r];
    if (typeof hc !== "number") return;
    const g = teamData.grossByRound[r];
    const n = teamData.netByRound[r];
    if (typeof g !== "number" || typeof n !== "number") return;
    const midY = (y(g) + y(n)) / 2;
    svg += `<text x="${x(i) + 12}" y="${midY + 4}" font-size="11" font-weight="600" fill="#2563eb">${hc >= 0 ? "+" : ""}${hc}</text>`;
  });

  svg += "</svg>";
  return svg;
}

function renderHCTrends() {
  const container = document.getElementById("hc-trends-view");
  container.innerHTML = "";

  const { teams, roundNums } = getTeamHCData();
  if (!teams.length) {
    container.innerHTML = "<p>Need both Trackman and Golf Genius data with team matching.</p>";
    return;
  }

  // Detail chart area
  const detailDiv = document.createElement("div");
  detailDiv.className = "hc-detail-chart";
  detailDiv.id = "hc-detail";
  detailDiv.innerHTML = "<p style='color:#94a3b8;font-size:0.85rem'>Click a team below to see their detailed trend</p>";
  container.appendChild(detailDiv);

  // Table
  const tableWrapper = document.createElement("div");
  tableWrapper.className = "table-wrapper";
  const table = document.createElement("table");
  table.id = "hc-trends-table";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  ["Pos", "Team", ...roundNums.map(r => `R${r} HC`), "Avg HC", "Trend"].forEach(label => {
    const th = document.createElement("th");
    th.textContent = label;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const team of teams) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";

    const tdPos = document.createElement("td");
    tdPos.textContent = team.pos === 999 ? "" : team.pos;
    tdPos.className = "num";
    tr.appendChild(tdPos);

    const tdName = document.createElement("td");
    tdName.textContent = team.tmName;
    tr.appendChild(tdName);

    for (const r of roundNums) {
      const td = document.createElement("td");
      const hc = team.hcByRound[r];
      td.textContent = typeof hc === "number" ? (hc >= 0 ? "+" + hc : hc) : "";
      td.className = "num";
      if (typeof hc === "number" && hc > 0) td.classList.add("diff-positive");
      tr.appendChild(td);
    }

    const tdAvg = document.createElement("td");
    tdAvg.textContent = team.avgHC.toFixed(1);
    tdAvg.className = "num";
    tr.appendChild(tdAvg);

    const tdTrend = document.createElement("td");
    tdTrend.innerHTML = svgSparkline(team.hcByRound, roundNums, 100, 28, "#2563eb");
    tdTrend.className = "hc-sparkline";
    tr.appendChild(tdTrend);

    tr.addEventListener("click", () => {
      tbody.querySelectorAll("tr").forEach(r => r.classList.remove("hc-selected"));
      tr.classList.add("hc-selected");
      showHCDetail(team, roundNums);
    });

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrapper.appendChild(table);
  container.appendChild(tableWrapper);
}

function showHCDetail(team, roundNums) {
  const el = document.getElementById("hc-detail");
  let html = `<h3>${team.tmName}`;
  if (team.ggName) html += ` <span style="color:#64748b;font-weight:normal;font-size:0.8rem">(${team.ggName})</span>`;
  html += `</h3>`;
  html += svgDetailChart(team, roundNums);
  html += `<div class="hc-legend">
    <span class="leg-gross">Gross Stableford</span>
    <span class="leg-net">Net Stableford</span>
    <span class="leg-hc">HC Benefit (shaded area)</span>
  </div>`;
  el.innerHTML = html;
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
      const hc = (typeof gross === "number" && typeof net === "number") ? gross - net : "";
      row.push(gross, net, hc);
      if (typeof gross === "number") totalGross += gross;
    }
    row.push(totalGross || "", tmData.total?.score ?? "");
    lbRows.push(row);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lbRows), "Leaderboard");

  // Sheet 2: Team Mapping
  const mapRows = [["Trackman Name", "Golf Genius Name", "Match Type", "Exact Rounds", "Compared Rounds", "Total Diff"]];
  const passLabels = { 1: "Exact", 2: "Near", 3: "Fuzzy", 4: "Name+Score" };
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
  renderHCTrends();
}

// ── Cache ──

const CACHE_KEY = "winterLeagueCache";

function saveCache() {
  const data = {
    tmTournament: state.tmTournament,
    tmLeaderboard: state.tmLeaderboard,
    ggData: state.ggData,
    cachedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Cache save failed:", e);
  }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data.tmLeaderboard || !data.ggData) return false;

    state.tmTournament = data.tmTournament;
    state.tmLeaderboard = data.tmLeaderboard;

    const { teams, rounds } = processTmData(data.tmLeaderboard);
    state.tmTeams = teams;
    state.tmRounds = rounds;
    state.mulligans = extractMulligans(rounds);

    state.ggData = data.ggData;
    state.ggTeams = buildGGTeams(data.ggData);
    state.ggNetTeams = buildGGNetTeams(data.ggData);

    runMatching();
    renderAll();

    const when = new Date(data.cachedAt);
    setStatus(`Loaded from cache (${when.toLocaleString()})`);
    return true;
  } catch (e) {
    console.warn("Cache load failed:", e);
    return false;
  }
}

function clearCache() {
  localStorage.removeItem(CACHE_KEY);
  setStatus("Cache cleared.");
}

async function fetchAll() {
  const btn = document.getElementById("btn-fetch-all");
  btn.disabled = true;
  try {
    await fetchTrackman();
    await fetchGolfGenius();
    runMatching();
    renderAll();
    saveCache();
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
document.getElementById("btn-clear-cache").addEventListener("click", clearCache);
loadCache();
