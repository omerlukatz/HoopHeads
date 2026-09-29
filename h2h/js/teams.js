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

// FIFA clubs and national teams. Stored as "F-" + code so they never clash with NBA codes
// (Milan / Bucks, Porto / Portland). No badge images yet: they show the code on the club colour.
const c = (abbr, name, nickname, color) => ({ key: `F-${abbr}`, abbr, city: '', nickname, name, color, logo: null });

export const CLUBS = [
  // England
  c('ARS', 'Arsenal', 'Arsenal', '#DB0007'),
  c('AVL', 'Aston Villa', 'Aston Villa', '#670E36'),
  c('BOU', 'AFC Bournemouth', 'Bournemouth', '#B50E12'),
  c('BRE', 'Brentford', 'Brentford', '#C8102E'),
  c('BHA', 'Brighton & Hove Albion', 'Brighton', '#0057B8'),
  c('CHE', 'Chelsea', 'Chelsea', '#034694'),
  c('CRY', 'Crystal Palace', 'Crystal Palace', '#1B458F'),
  c('EVE', 'Everton', 'Everton', '#003399'),
  c('FUL', 'Fulham', 'Fulham', '#1D1D1B'),
  c('LEE', 'Leeds United', 'Leeds', '#1D428A'),
  c('LIV', 'Liverpool', 'Liverpool', '#C8102E'),
  c('MCI', 'Manchester City', 'Man City', '#1C6BAE'),
  c('MUN', 'Manchester United', 'Man United', '#DA291C'),
  c('NEW', 'Newcastle United', 'Newcastle', '#241F20'),
  c('NFO', 'Nottingham Forest', 'Nott’m Forest', '#C8102E'),
  c('TOT', 'Tottenham Hotspur', 'Tottenham', '#132257'),
  c('WHU', 'West Ham United', 'West Ham', '#7A263A'),
  c('WOL', 'Wolverhampton Wanderers', 'Wolves', '#231F20'),
  // Spain
  c('RMA', 'Real Madrid', 'Real Madrid', '#00529F'),
  c('BAR', 'FC Barcelona', 'Barcelona', '#A50044'),
  c('ATM', 'Atlético de Madrid', 'Atlético', '#CB3524'),
  c('ATH', 'Athletic Club', 'Athletic', '#D4121C'),
  c('RSO', 'Real Sociedad', 'Real Sociedad', '#0067B1'),
  c('BET', 'Real Betis', 'Betis', '#007A3D'),
  c('VIL', 'Villarreal', 'Villarreal', '#8A6D00'),
  c('SEV', 'Sevilla', 'Sevilla', '#C8102E'),
  c('VAL', 'Valencia', 'Valencia', '#1D1D1B'),
  c('GIR', 'Girona', 'Girona', '#CD2534'),
  // Italy
  c('INT', 'Inter', 'Inter', '#010E80'),
  c('ACM', 'AC Milan', 'Milan', '#C8102E'),
  c('JUV', 'Juventus', 'Juventus', '#1D1D1B'),
  c('NAP', 'Napoli', 'Napoli', '#0067B1'),
  c('ROM', 'AS Roma', 'Roma', '#8E1F2F'),
  c('LAZ', 'Lazio', 'Lazio', '#1B5C9E'),
  c('ATA', 'Atalanta', 'Atalanta', '#1E60A8'),
  c('FIO', 'Fiorentina', 'Fiorentina', '#482E92'),
  // Germany
  c('FCB', 'FC Bayern München', 'Bayern', '#DC052D'),
  c('BVB', 'Borussia Dortmund', 'Dortmund', '#1D1D1B'),
  c('B04', 'Bayer 04 Leverkusen', 'Leverkusen', '#D71920'),
  c('RBL', 'RB Leipzig', 'Leipzig', '#C8102E'),
  c('SGE', 'Eintracht Frankfurt', 'Frankfurt', '#C8102E'),
  c('VFB', 'VfB Stuttgart', 'Stuttgart', '#C8102E'),
  // France
  c('PSG', 'Paris Saint-Germain', 'PSG', '#004170'),
  c('OM', 'Olympique de Marseille', 'Marseille', '#0B6FA4'),
  c('OL', 'Olympique Lyonnais', 'Lyon', '#1A3D8F'),
  c('ASM', 'AS Monaco', 'Monaco', '#D4151F'),
  c('LIL', 'LOSC Lille', 'Lille', '#C8102E'),
  // Rest of Europe
  c('AJA', 'Ajax', 'Ajax', '#C8102E'),
  c('PSV', 'PSV', 'PSV', '#C8102E'),
  c('FEY', 'Feyenoord', 'Feyenoord', '#C8102E'),
  c('FCP', 'FC Porto', 'Porto', '#00428C'),
  c('SLB', 'Benfica', 'Benfica', '#D4121C'),
  c('SCP', 'Sporting CP', 'Sporting', '#00764B'),
  c('CEL', 'Celtic', 'Celtic', '#00804B'),
  c('RAN', 'Rangers', 'Rangers', '#1B458F'),
  c('GAL', 'Galatasaray', 'Galatasaray', '#A90432'),
  c('FEN', 'Fenerbahçe', 'Fenerbahçe', '#002D72'),
  // Americas & Saudi Arabia
  c('MIA', 'Inter Miami', 'Inter Miami', '#231F20'),
  c('LAG', 'LA Galaxy', 'LA Galaxy', '#00245D'),
  c('LAF', 'LAFC', 'LAFC', '#1D1D1B'),
  c('BOC', 'Boca Juniors', 'Boca Juniors', '#103F79'),
  c('RIV', 'River Plate', 'River Plate', '#C8102E'),
  c('FLA', 'Flamengo', 'Flamengo', '#C3281E'),
  c('NAS', 'Al Nassr', 'Al Nassr', '#1D3A8A'),
  c('HIL', 'Al Hilal', 'Al Hilal', '#1C4E9D'),
  c('ITT', 'Al Ittihad', 'Al Ittihad', '#1D1D1B'),
  // National teams
  c('ARG', 'Argentina', 'Argentina', '#2B6CB0'),
  c('BRA', 'Brazil', 'Brazil', '#00843D'),
  c('FRA', 'France', 'France', '#002395'),
  c('ENG', 'England', 'England', '#1D1D6B'),
  c('ESP', 'Spain', 'Spain', '#AA151B'),
  c('GER', 'Germany', 'Germany', '#1D1D1B'),
  c('POR', 'Portugal', 'Portugal', '#006600'),
  c('NED', 'Netherlands', 'Netherlands', '#C2410C'),
  c('ITA', 'Italy', 'Italy', '#1C4FA0'),
  c('BEL', 'Belgium', 'Belgium', '#C8102E'),
  c('CRO', 'Croatia', 'Croatia', '#C8102E'),
  c('URU', 'Uruguay', 'Uruguay', '#2B6CB0'),
  c('USA', 'United States', 'USA', '#0A3161'),
  c('MEX', 'Mexico', 'Mexico', '#006847'),
  c('MAR', 'Morocco', 'Morocco', '#C1272D'),
  c('JPN', 'Japan', 'Japan', '#1B3F8F'),
];
for (const team of TEAMS) team.key = team.abbr;

const BY_KEY = new Map([...TEAMS, ...CLUBS].map((team) => [team.key, team]));

/** Looks up an NBA team ("LAL") or a FIFA team ("F-ARS"). */
export function getTeam(key) {
  const k = String(key || '');
  return BY_KEY.get(k.startsWith('F-') ? k : k.toUpperCase()) || null;
}

/** The team list for a game mode ('2k' or 'fifa'). */
export const teamsFor = (sport) => (sport === 'fifa' ? CLUBS : TEAMS);

const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '');

/** Matches city, nickname, full name, or abbreviation. Abbreviation / prefix matches rank first. */
export function searchTeams(query, list = TEAMS) {
  const q = normalize(query.trim());
  if (!q) return list;
  const scored = [];
  for (const team of list) {
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
