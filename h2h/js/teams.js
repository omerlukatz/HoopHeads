// Single source of truth for team data. Everything that renders a team reads from here.

const t = (abbr, city, nickname, color, name = `${city} ${nickname}`) => ({
  abbr,
  city,
  nickname,
  name,
  color,
  logo: `assets/logos/${abbr.toLowerCase()}.webp`,
});

export const TEAMS = [
  t('ATL', 'Atlanta', 'Hawks', '#E03A3E'),
  t('BOS', 'Boston', 'Celtics', '#007A33'),
  t('BKN', 'Brooklyn', 'Nets', '#000000'),
  t('CHA', 'Charlotte', 'Hornets', '#1D1160'),
  t('CHI', 'Chicago', 'Bulls', '#CE1141'),
  t('CLE', 'Cleveland', 'Cavaliers', '#860038'),
  t('DAL', 'Dallas', 'Mavericks', '#00538C'),
  t('DEN', 'Denver', 'Nuggets', '#0E2240'),
  t('DET', 'Detroit', 'Pistons', '#C8102E'),
  t('GSW', 'Golden State', 'Warriors', '#1D428A'),
  t('HOU', 'Houston', 'Rockets', '#CE1141'),
  t('IND', 'Indiana', 'Pacers', '#002D62'),
  t('LAC', 'Los Angeles', 'Clippers', '#C8102E', 'LA Clippers'),
  t('LAL', 'Los Angeles', 'Lakers', '#552583'),
  t('MEM', 'Memphis', 'Grizzlies', '#5D76A9'),
  t('MIA', 'Miami', 'Heat', '#98002E'),
  t('MIL', 'Milwaukee', 'Bucks', '#00471B'),
  t('MIN', 'Minnesota', 'Timberwolves', '#0C2340'),
  t('NOP', 'New Orleans', 'Pelicans', '#0C2340'),
  t('NYK', 'New York', 'Knicks', '#006BB6'),
  t('OKC', 'Oklahoma City', 'Thunder', '#007AC1'),
  t('ORL', 'Orlando', 'Magic', '#0077C0'),
  t('PHI', 'Philadelphia', '76ers', '#006BB6'),
  t('PHX', 'Phoenix', 'Suns', '#1D1160'),
  t('POR', 'Portland', 'Trail Blazers', '#E03A3E'),
  t('SAC', 'Sacramento', 'Kings', '#5A2D81'),
  t('SAS', 'San Antonio', 'Spurs', '#000000'),
  t('TOR', 'Toronto', 'Raptors', '#CE1141'),
  t('UTA', 'Utah', 'Jazz', '#002B5C'),
  t('WAS', 'Washington', 'Wizards', '#002B5C'),
];

const BY_ABBR = new Map(TEAMS.map((team) => [team.abbr, team]));

export function getTeam(abbr) {
  return BY_ABBR.get(String(abbr || '').toUpperCase()) || null;
}

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '');

/** Matches city, nickname, full name, or abbreviation. Abbreviation / prefix matches rank first. */
export function searchTeams(query) {
  const q = normalize(query.trim());
  if (!q) return TEAMS;
  const scored = [];
  for (const team of TEAMS) {
    const abbr = team.abbr.toLowerCase();
    const fields = [team.city, team.nickname, team.name].map(normalize);
    let score = 0;
    if (abbr === q) score = 4;
    else if (fields.some((f) => f.startsWith(q))) score = 3;
    else if (abbr.startsWith(q)) score = 2;
    else if (fields.some((f) => f.split(' ').some((w) => w.startsWith(q)) || f.includes(q))) score = 1;
    if (score) scored.push([score, team]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, team]) => team);
}
