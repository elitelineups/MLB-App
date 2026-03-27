import * as XLSX from 'xlsx';
import { formatDecimalOdds, formatRuns } from './model';

function sanitizeSheetName(name, fallback) {
  const cleaned = String(name || fallback || 'Sheet')
    .replace(/[\[\]\*\/\\\?\:]/g, ' ')
    .trim();
  return (cleaned || fallback || 'Sheet').slice(0, 31);
}

function projectionSummaryRows(gamesWithProjections, date) {
  return gamesWithProjections.map(({ game, projections }) => ({
    date,
    matchup: `${game.awayTeam.abbreviation} at ${game.homeTeam.abbreviation}`,
    venue: game.venue || '',
    status: game.status || '',
    fgAwayRuns: formatRuns(projections.fullGame.awayRuns),
    fgHomeRuns: formatRuns(projections.fullGame.homeRuns),
    fgTotal: formatRuns(projections.fullGame.total),
    fgAwayDecimal: formatDecimalOdds(projections.fullGame.awayWinProbability),
    fgHomeDecimal: formatDecimalOdds(projections.fullGame.homeWinProbability),
    f5AwayRuns: formatRuns(projections.firstFive.awayRuns),
    f5HomeRuns: formatRuns(projections.firstFive.homeRuns),
    f5Total: formatRuns(projections.firstFive.total),
    f5AwayDecimal: formatDecimalOdds(projections.firstFive.awayWinProbability),
    f5HomeDecimal: formatDecimalOdds(projections.firstFive.homeWinProbability),
  }));
}

function projectionDetailRows(game, projections, selectedDate) {
  return [
    {
      date: selectedDate,
      matchup: `${game.awayTeam.abbreviation} at ${game.homeTeam.abbreviation}`,
      venue: game.venue || '',
      status: game.status || '',
      awayTeam: game.awayTeam.name || game.awayTeam.abbreviation,
      homeTeam: game.homeTeam.name || game.homeTeam.abbreviation,
      fgAwayRuns: formatRuns(projections.fullGame.awayRuns),
      fgHomeRuns: formatRuns(projections.fullGame.homeRuns),
      fgTotal: formatRuns(projections.fullGame.total),
      fgAwayDecimal: formatDecimalOdds(projections.fullGame.awayWinProbability),
      fgHomeDecimal: formatDecimalOdds(projections.fullGame.homeWinProbability),
      f5AwayRuns: formatRuns(projections.firstFive.awayRuns),
      f5HomeRuns: formatRuns(projections.firstFive.homeRuns),
      f5Total: formatRuns(projections.firstFive.total),
      f5AwayDecimal: formatDecimalOdds(projections.firstFive.awayWinProbability),
      f5HomeDecimal: formatDecimalOdds(projections.firstFive.homeWinProbability),
      awayLineupRating: formatRuns(projections.offense.awayLineupRating),
      homeLineupRating: formatRuns(projections.offense.homeLineupRating),
      awayTeamStrength: formatRuns(projections.offense.awayTeamStrengthRating),
      homeTeamStrength: formatRuns(projections.offense.homeTeamStrengthRating),
      awayEffectiveRating: formatRuns(projections.offense.awayEffectiveRating),
      homeEffectiveRating: formatRuns(projections.offense.homeEffectiveRating),
      awayStarterKs: formatRuns(projections.strikeouts.awayStarter),
      homeStarterKs: formatRuns(projections.strikeouts.homeStarter),
    },
  ];
}

export function downloadProjectionWorkbook({ date, gamesWithProjections }) {
  const entries = Array.isArray(gamesWithProjections) ? gamesWithProjections : [];
  if (!entries.length) {
    return;
  }

  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.json_to_sheet(projectionSummaryRows(entries, date));
  XLSX.utils.book_append_sheet(workbook, summarySheet, sanitizeSheetName(`Summary ${date}`, 'Summary'));

  entries.forEach(({ game, projections }, index) => {
    const sheetName = sanitizeSheetName(
      `${index + 1}-${game.awayTeam.abbreviation}-${game.homeTeam.abbreviation}`,
      `Game ${index + 1}`
    );
    const detailSheet = XLSX.utils.json_to_sheet(projectionDetailRows(game, projections, date));
    XLSX.utils.book_append_sheet(workbook, detailSheet, sheetName);
  });

  XLSX.writeFile(workbook, `mlb-projections-${date}.xlsx`);
}
