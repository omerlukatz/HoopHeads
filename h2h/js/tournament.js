// Tournaments. A tournament stores who's in it, its rules and how it was drawn; everything else
// (group tables, series scores, who advances, the champion) is worked out from the games logged for
// it, so editing or deleting one of those games puts it right by itself.
//
// Tournament: { id, name, sport, creator, created_at, status ('inviting' | 'live' | 'cancelled'),
//   players: [ids invited, creator first], answers: { id: 'pending' | 'accepted' | 'declined' },
//   people: { id: name/avatar }, invited_by: { id: who invited them },
//   format ('knockout' | 'groups': a group stage, then the top two of each group in a knockout),
//   group_games (games against each group opponent), best_of: { early, semi, final },
//   draw ('random' | 'seeded' | 'custom': the host places everyone when starting it),
//   auto_start (starts when everyone has answered), deadline_days (0 = none; days per round),
//   seeds: [ids, null = a bye] (knockout format, set at the start), groups: [{ ids }] (groups format;
//   Firestore can't store lists of lists), replaced: { old id: new id } (the host swapped a player),
//   decisions: { 'round-index': { winner, at } } (the host decided a series),
//   nudges: { id: { from, at } } ("ready to play?"), left: { id: when they quit } (after the start:
//   their opponent wins by forfeit; answers[id] becomes 'left'), started_at }
// A game counts when it carries tournament_id (and tournament_stage 'group' in a group stage) and
// is between the two players of an undecided series; games after a series is decided don't count.

export const BEST_OF = [1, 3, 5, 7, 9]; // odd, so a series can't end level
export const MAX_BEST_OF = 9;
export const MAX_GROUP_GAMES = 3;
export const MAX_DEADLINE_DAYS = 14;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 16;
/** Quick set-ups for the series lengths. */
export const PRESETS = [
  { id: 'quick', name: 'Quick Cup', sub: 'One game decides every round', best_of: { early: 1, semi: 1, final: 1 } },
  { id: 'classic', name: 'Classic', sub: 'Best of 3, final best of 5', best_of: { early: 3, semi: 3, final: 5 } },
  { id: 'marathon', name: 'Marathon', sub: 'Best of 5, final best of 7', best_of: { early: 5, semi: 5, final: 7 } },
];
const DAY = 86400000;
const GROUP_NAMES = 'ABCDEFGH';

/** "Final", "Semifinals", "Quarterfinals", "Round of 16" (counting back from the final). */
export function roundName(round, rounds) {
  const left = rounds - round; // 1 = final
  return left === 1 ? 'Final' : left === 2 ? 'Semifinals' : left === 3 ? 'Quarterfinals' : `Round of ${2 ** left}`;
}
export const groupName = (i) => `Group ${GROUP_NAMES[i]}`;

/** Games in a series this round: the final and semifinals can be longer. */
export function bestOfFor(t, round, rounds) {
  const left = rounds - round;
  const b = t.best_of || {};
  return Number(left === 1 ? b.final : left === 2 ? b.semi : b.early) || 1;
}

const nextPow2 = (n) => {
  let size = 2;
  while (size < n) size *= 2;
  return size;
};

function shuffle(list, random = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A random knockout draw: spare slots are byes, at most one per first-round match. */
export function drawBracket(ids, random = Math.random) {
  const players = shuffle(ids, random);
  const size = nextPow2(players.length);
  const byes = size - players.length;
  const pairs = [];
  for (let i = 0; i < size / 2; i++) pairs.push(i < byes ? [players.shift(), null] : [players.shift(), players.shift()]);
  return shuffle(pairs, random).flat();
}

/** A seeded draw, strongest first: 1 v 8, 4 v 5, 2 v 7, 3 v 6… The top seeds get the byes. */
export function seededBracket(ranked) {
  const size = nextPow2(ranked.length);
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, m - seed]);
  }
  return order.map((seed) => ranked[seed - 1] ?? null);
}

/** How many groups for this many players (groups of 3 to 5, so everyone gets a few games). */
export const groupCount = (n) => (n <= 5 ? 1 : Math.ceil(n / 4));

/** Players into groups: `ranked` strongest first goes round in a snake (A B C C B A…) to keep it even. */
export function makeGroups(ranked) {
  const g = groupCount(ranked.length);
  const groups = Array.from({ length: g }, () => []);
  ranked.forEach((id, i) => {
    const lap = Math.floor(i / g);
    groups[lap % 2 ? g - 1 - (i % g) : i % g].push(id);
  });
  return groups;
}

/**
 * Win rate in this game across all their games, strongest first (players with few games count as
 * average, so a newcomer isn't seeded last for having played little).
 */
export function rankByRecord(ids, games, sport) {
  return ids
    .map((id) => ({ id, r: recordOf(id, games, sport).rate }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.id);
}
export function recordOf(id, games, sport) {
  let won = 0, played = 0;
  for (const g of games) {
    if (g.deleted || (g.sport || '2k') !== sport || (g.player1_id !== id && g.player2_id !== id)) continue;
    const w = winnerOf(g);
    played++;
    if (w === id) won++;
    else if (!w) won += 0.5;
  }
  return { played, won, rate: (won + 2.5) / (played + 5), pct: played ? Math.round((100 * won) / played) : null };
}

/** How a tournament starts, as its settings say: { seeds } or { groups } (custom starts from random). */
export function drawFor(t, players, games = []) {
  const ranked = t.draw === 'seeded' ? rankByRecord(players, games, t.sport) : shuffle(players);
  if (t.format === 'groups') return { groups: makeGroups(ranked) };
  return { seeds: t.draw === 'seeded' ? seededBracket(ranked) : drawBracket(players) };
}

/** Checks a knockout bracket the host set up. Returns an error message, or null if it's fine. */
export function checkSeeds(seeds, players) {
  if (!Array.isArray(seeds) || seeds.length < 2 || (seeds.length & (seeds.length - 1)) !== 0) return 'The bracket has the wrong number of places.';
  const placed = seeds.filter(Boolean);
  if (placed.length !== players.length || new Set(placed).size !== placed.length || placed.some((id) => !players.includes(id))) return 'Everyone who joined needs exactly one place.';
  if (seeds.length / 2 >= players.length) return 'There are too many free passes for this many players.';
  for (let i = 0; i < seeds.length; i += 2) if (!seeds[i] && !seeds[i + 1]) return 'A match can’t be two free passes.';
  return null;
}

/** Checks groups the host set up. */
export function checkGroups(groups, players) {
  if (!Array.isArray(groups) || !groups.length) return 'Add at least one group.';
  const placed = groups.flat();
  if (placed.length !== players.length || new Set(placed).size !== placed.length || placed.some((id) => !players.includes(id))) return 'Everyone who joined needs exactly one group.';
  if (groups.some((g) => g.length < 2)) return 'Every group needs at least 2 players.';
  return null;
}

/** Settings as they're stored (anything odd falls back to a sensible default). */
export function cleanSettings(s = {}) {
  const bo = (v) => (BEST_OF.includes(Number(v)) ? Number(v) : 1);
  const draw = ['seeded', 'custom'].includes(s.draw) ? s.draw : 'random';
  return {
    sport: s.sport === 'fifa' ? 'fifa' : '2k',
    format: s.format === 'groups' ? 'groups' : 'knockout',
    group_games: Math.min(MAX_GROUP_GAMES, Math.max(1, Math.round(Number(s.group_games)) || 1)),
    best_of: { early: bo(s.best_of?.early), semi: bo(s.best_of?.semi), final: bo(s.best_of?.final) },
    draw,
    auto_start: draw !== 'custom' && s.auto_start !== false, // a custom one is set up and started by the host
    deadline_days: Math.min(MAX_DEADLINE_DAYS, Math.max(0, Math.round(Number(s.deadline_days)) || 0)),
  };
}
export const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);

/** A layout the host set up by hand ({ seeds } or { groups }), checked. Error message or null. */
export function checkLayout(t, layout, players) {
  return t.format === 'groups' ? checkGroups((layout?.groups || []).map(groupIds), players) : checkSeeds(layout?.seeds, players);
}
/** A group's players (stored as { ids }, or a plain list in older data). */
export const groupIds = (g) => (Array.isArray(g) ? g : g?.ids || []);
/** The layout as stored: groups become [{ ids }]. */
export const storedLayout = (layout) => (layout.groups ? { groups: layout.groups.map((g) => ({ ids: groupIds(g) })) } : { seeds: layout.seeds });

export const allAnswered = (t) => !t.players.some((id) => t.answers?.[id] === 'pending');
export const accepted = (t) => t.players.filter((id) => t.answers?.[id] === 'accepted');
const leftAt = (t, id) => (id && t.left?.[id]) || null;
/** Who runs the tournament: the host, or if they quit, whoever's been in it longest. */
export const hostOf = (t) => t.host || (leftAt(t, t.creator) ? accepted(t)[0] || t.creator : t.creator);
/** Who takes over when `me` quits (the host hands it on; anyone else keeps the host as is). */
export const nextHost = (t, me) => (hostOf(t) === me ? t.players.find((id) => id !== me && t.answers?.[id] === 'accepted') || null : null);
const decisionOf = (t, key) => {
  const d = t.decisions?.[key];
  return d ? (typeof d === 'string' ? { winner: d, at: t.started_at } : d) : null;
};

/** Who won a game (penalties decide a level FIFA game), or null for a draw. */
export function winnerOf(g) {
  const s1 = Number(g.player1_score), s2 = Number(g.player2_score);
  if (s1 !== s2) return s1 > s2 ? g.player1_id : g.player2_id;
  const p1 = g.player1_pens, p2 = g.player2_pens;
  if (p1 === '' || p2 === '' || p1 == null || p2 == null || Number(p1) === Number(p2)) return null;
  return Number(p1) > Number(p2) ? g.player1_id : g.player2_id;
}
const between = (g, a, b) => (g.player1_id === a && g.player2_id === b) || (g.player1_id === b && g.player2_id === a);
const scoreFor = (g, id) => (g.player1_id === id ? Number(g.player1_score) : Number(g.player2_score));
const latest = (...times) => times.filter(Boolean).sort().pop() || null;

/**
 * The whole tournament as it stands (`now` decides deadlines):
 *   stage: 'groups' | 'knockout' | 'done'
 *   groups: [{ name, ids, table: [{ id, played, w, d, l, pts, diff }], pairs, done }] (groups format)
 *   rounds: knockout rounds of matches { key, round, index, a, b, need, bestOf, winsA, winsB, games,
 *     winner, bye, decidedBy ('games' | 'host' | 'deadline'), decidedAt, readyAt, deadline, overdue }
 *   A player id of undefined means "still to be decided" (label in `labels`); null is a bye.
 *   champion, runnerUp, semifinalists
 */
export function buildBracket(t, games, now = Date.now()) {
  const days = Number(t.deadline_days) || 0;
  const ours = games
    .filter((g) => g.tournament_id === t.id && !g.deleted)
    .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id)));
  const out = { stage: 'knockout', groups: null, rounds: [], labels: [], champion: null, runnerUp: null, semifinalists: [], groupsDeadline: null, groupsEnd: null };
  let seeds = t.seeds || [];
  let koStart = t.started_at;

  if (t.format === 'groups' && Array.isArray(t.groups) && t.groups.length) {
    const lists = t.groups.map(groupIds);
    const need = Number(t.group_games) || 1;
    const groupGames = ours.filter((g) => g.tournament_stage === 'group');
    const deadline = days && t.started_at ? new Date(Date.parse(t.started_at) + days * DAY).toISOString() : null;
    const expired = deadline && now > Date.parse(deadline);
    let lastGame = null;
    out.groups = lists.map((ids, gi) => {
      const rows = new Map(ids.map((id) => [id, { id, played: 0, w: 0, d: 0, l: 0, pts: 0, diff: 0 }]));
      const pairs = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i], b = ids[j];
          const counted = groupGames.filter((g) => between(g, a, b)).slice(0, need);
          for (const g of counted) {
            const w = winnerOf(g);
            const ra = rows.get(a), rb = rows.get(b);
            ra.played++, rb.played++;
            ra.diff += scoreFor(g, a) - scoreFor(g, b);
            rb.diff += scoreFor(g, b) - scoreFor(g, a);
            if (!w) (ra.d++, rb.d++, (ra.pts += 1), (rb.pts += 1));
            else if (w === a) (ra.w++, rb.l++, (ra.pts += 3));
            else (rb.w++, ra.l++, (rb.pts += 3));
            lastGame = latest(lastGame, g.created_at);
          }
          // Someone who quit loses the group games they still had to play
          const quitter = leftAt(t, a) && !leftAt(t, b) ? a : leftAt(t, b) && !leftAt(t, a) ? b : null;
          const missing = need - counted.length;
          if (quitter && missing > 0) {
            const winner = rows.get(quitter === a ? b : a), loser = rows.get(quitter);
            (winner.played += missing), (winner.w += missing), (winner.pts += 3 * missing);
            (loser.played += missing), (loser.l += missing);
          }
          pairs.push({ a, b, games: counted, need, done: counted.length >= need || Boolean(leftAt(t, a) || leftAt(t, b)), forfeit: quitter });
        }
      }
      const quit = (x) => (leftAt(t, x.id) ? 1 : 0); // whoever quit goes to the bottom
      const order = (x, y) => quit(x) - quit(y) || y.pts - x.pts || y.w - x.w || y.diff - x.diff || ids.indexOf(x.id) - ids.indexOf(y.id);
      return { name: groupName(gi), ids, table: [...rows.values()].sort(order), pairs, done: pairs.every((p) => p.done) };
    });
    const done = out.groups.every((g) => g.done) || Boolean(expired);
    out.groupsDeadline = deadline;
    if (!done) out.stage = 'groups';
    out.groupsEnd = done ? (out.groups.every((g) => g.done) ? lastGame || t.started_at : deadline) : null;
    koStart = out.groupsEnd;
    // Into the knockout: group winners, then runners-up (so nobody meets their own group straight away)
    const stayed = (g) => g.table.filter((r) => !leftAt(t, r.id));
    const winners = out.groups.map((g) => stayed(g)[0]?.id ?? null);
    const runners = out.groups.map((g) => stayed(g)[1]?.id ?? null);
    const labels = [...out.groups.map((g) => `Winner, ${g.name}`), ...out.groups.map((g) => `Runner-up, ${g.name}`)];
    const ranked = [...winners, ...runners];
    out.labels = seededBracket(labels); // what each place will be, until the groups are done
    seeds = done ? seededBracket(ranked) : out.labels.map((x) => (x === null ? null : undefined));
  }

  if (seeds.length < 2) return out;
  const koGames = t.format === 'groups' ? ours.filter((g) => g.tournament_stage !== 'group') : ours;
  const total = Math.log2(seeds.length);
  let slots = seeds.map((id) => (id === null ? null : id));
  let feeders = null; // last round's matches (for when the next one became ready)
  for (let r = 0; r < total; r++) {
    const bestOf = bestOfFor(t, r, total);
    const need = Math.ceil(bestOf / 2);
    const deadline = days && koStart ? new Date(Date.parse(koStart) + days * (r + 1) * DAY).toISOString() : null;
    const matches = [];
    for (let i = 0; i < slots.length / 2; i++) {
      const a = slots[2 * i], b = slots[2 * i + 1];
      const key = `${r}-${i}`;
      const m = { key, round: r, index: i, a, b, need, bestOf, winsA: 0, winsB: 0, games: [], winner: undefined, bye: false, decidedBy: null, decidedAt: null, readyAt: null, deadline, overdue: false };
      if (a === null || b === null) {
        m.bye = true;
        m.winner = a === null ? b : a;
        m.decidedAt = koStart;
      } else if (a !== undefined && b !== undefined) {
        m.readyAt = r === 0 ? koStart : latest(feeders[2 * i]?.decidedAt, feeders[2 * i + 1]?.decidedAt);
        const host = decisionOf(t, key);
        for (const g of koGames) {
          if (m.winner !== undefined) break;
          if (!between(g, a, b)) continue;
          const w = winnerOf(g);
          if (!w) continue; // a draw doesn't count
          m.games.push(g);
          if (w === a) m.winsA++;
          else m.winsB++;
          if (m.winsA === need || m.winsB === need) Object.assign(m, { winner: m.winsA === need ? a : b, decidedBy: 'games', decidedAt: g.created_at });
        }
        const qa = leftAt(t, a), qb = leftAt(t, b);
        if (m.winner === undefined && (qa || qb)) {
          // Someone quit: the other goes through (if both did, whoever stayed longer)
          const winner = qa && qb ? (qa > qb ? a : b) : qa ? b : a;
          Object.assign(m, { winner, decidedBy: 'forfeit', decidedAt: latest(m.readyAt, qa && qb ? (qa < qb ? qa : qb) : qa || qb) });
        } else if (m.winner === undefined && host && (host.winner === a || host.winner === b)) {
          Object.assign(m, { winner: host.winner, decidedBy: 'host', decidedAt: host.at });
        } else if (m.winner === undefined && deadline && now > Date.parse(deadline)) {
          // Past the deadline: whoever's ahead goes through; level, and the host decides
          if (m.winsA !== m.winsB) Object.assign(m, { winner: m.winsA > m.winsB ? a : b, decidedBy: 'deadline', decidedAt: deadline });
          else m.overdue = true;
        }
      }
      matches.push(m);
    }
    out.rounds.push(matches);
    feeders = matches;
    slots = matches.map((m) => m.winner);
  }
  const final = out.rounds.at(-1)[0];
  out.champion = final.winner ?? null;
  if (out.champion) out.runnerUp = final.a === out.champion ? final.b : final.a;
  if (total >= 2) out.semifinalists = out.rounds[total - 2].filter((m) => m.winner && !m.bye).map((m) => (m.winner === m.a ? m.b : m.a));
  out.stage = out.champion ? 'done' : out.stage;
  return out;
}

/** Your knockout series in progress (both players known, not decided yet), or null. */
export function currentMatch(b, me) {
  if (b.stage === 'groups') return null;
  for (const round of b.rounds) for (const m of round) if (m.winner === undefined && m.a && m.b && (m.a === me || m.b === me)) return m;
  return null;
}

/** Your group, and your group games still to play: { group, todo: [{ opp, played, need }] }, or null. */
export function groupTodo(b, me) {
  if (b.stage !== 'groups' || !b.groups) return null;
  const group = b.groups.find((g) => g.ids.includes(me));
  if (!group) return null;
  const todo = group.pairs.filter((p) => !p.done && (p.a === me || p.b === me)).map((p) => ({ opp: p.a === me ? p.b : p.a, played: p.games.length, need: p.need }));
  return { group, todo };
}

/** Where you went out: { stage: 'group', group } or the match you lost; null if you're still in. */
export function knockedOutIn(b, me) {
  if (b.groups && b.stage !== 'groups') {
    const group = b.groups.find((g) => g.ids.includes(me));
    const through = b.rounds[0]?.flatMap((m) => [m.a, m.b]).includes(me);
    if (group && !through) return { stage: 'group', group };
  }
  for (const round of b.rounds) for (const m of round) if ((m.a === me || m.b === me) && m.winner && m.winner !== me && !m.bye) return m;
  return null;
}

/**
 * What happened to you in a tournament, for the Notifications page: [{ at, kind, ... }], newest first.
 * kinds: started, ready (your series), won, lost, champion (someone else won it), nudge, deadline,
 * groups (the group stage ended: through or not).
 */
export function eventsFor(t, b, me, now = Date.now()) {
  const ev = [];
  if (!t.players.includes(me) || t.answers?.[me] !== 'accepted' || t.status !== 'live') return ev;
  ev.push({ at: t.started_at, kind: 'started' });
  const total = b.rounds.length;
  if (b.groups && b.groupsEnd) {
    const out = knockedOutIn(b, me);
    ev.push({ at: b.groupsEnd, kind: 'groups', through: !(out && out.stage === 'group') });
  }
  for (const round of b.rounds) {
    for (const m of round) {
      if (m.bye || (m.a !== me && m.b !== me)) continue;
      const opp = m.a === me ? m.b : m.a;
      if (m.readyAt && opp) ev.push({ at: m.readyAt, kind: 'ready', round: m.round, total, opp });
      if (m.winner && m.decidedAt) ev.push({ at: m.decidedAt, kind: m.winner === me ? 'won' : 'lost', round: m.round, total, opp, by: m.decidedBy });
      if (m.winner === undefined && m.deadline && opp) {
        const warn = Date.parse(m.deadline) - DAY;
        if (now > warn && now < Date.parse(m.deadline)) ev.push({ at: new Date(warn).toISOString(), kind: 'deadline', round: m.round, total, opp, deadline: m.deadline });
      }
    }
  }
  if (b.champion && b.champion !== me) ev.push({ at: b.rounds.at(-1)[0].decidedAt, kind: 'champion', who: b.champion });
  const nudge = t.nudges?.[me];
  if (nudge && b.stage !== 'done') ev.push({ at: nudge.at, kind: 'nudge', from: nudge.from });
  return ev.filter((e) => e.at).sort((x, y) => String(y.at).localeCompare(String(x.at)));
}

/** Highlights of a tournament's games: biggest win, closest game, games played. */
export function highlights(t, b) {
  const counted = [...(b.groups || []).flatMap((g) => g.pairs.flatMap((p) => p.games)), ...b.rounds.flatMap((r) => r.flatMap((m) => m.games))];
  const margin = (g) => Math.abs(Number(g.player1_score) - Number(g.player2_score));
  const decisive = counted.filter((g) => winnerOf(g));
  const biggest = decisive.slice().sort((x, y) => margin(y) - margin(x))[0] || null;
  const closest = decisive.slice().sort((x, y) => margin(x) - margin(y))[0] || null;
  return { games: counted.length, biggest, closest };
}
