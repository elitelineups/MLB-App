import TeamBadge from './TeamBadge';

function ResultRow({ label, awayValue, totalValue = '', homeValue }) {
  return (
    <div className="result-row">
      <span className="result-label">{label}</span>
      <strong>{awayValue}</strong>
      <strong>{totalValue}</strong>
      <strong>{homeValue}</strong>
    </div>
  );
}

function ProjectionResults({
  projections,
  awayTeam,
  homeTeam,
  formatRuns,
  formatDecimalOdds,
  awayLastOuting,
  homeLastOuting,
}) {
  return (
    <aside className="results-card">
      <div className="results-header">
        <span className="results-header-spacer" />
        <TeamBadge abbreviation={awayTeam.abbreviation} name={awayTeam.name} compact />
        <span className="results-total-chip">TOTAL</span>
        <TeamBadge abbreviation={homeTeam.abbreviation} name={homeTeam.name} compact />
      </div>
      <ResultRow
        label="Full game runs"
        awayValue={formatRuns(projections.fullGame.awayRuns)}
        totalValue={formatRuns(projections.fullGame.total)}
        homeValue={formatRuns(projections.fullGame.homeRuns)}
      />
      <ResultRow
        label="First 5 runs"
        awayValue={formatRuns(projections.firstFive.awayRuns)}
        totalValue={formatRuns(projections.firstFive.total)}
        homeValue={formatRuns(projections.firstFive.homeRuns)}
      />
      <ResultRow
        label="Full game decimal"
        awayValue={formatDecimalOdds(projections.fullGame.awayWinProbability)}
        homeValue={formatDecimalOdds(projections.fullGame.homeWinProbability)}
      />
      <ResultRow
        label="First 5 decimal"
        awayValue={formatDecimalOdds(projections.firstFive.awayWinProbability)}
        homeValue={formatDecimalOdds(projections.firstFive.homeWinProbability)}
      />
      <ResultRow
        label="Lineup rating"
        awayValue={formatRuns(projections.offense.awayLineupRating)}
        homeValue={formatRuns(projections.offense.homeLineupRating)}
      />
      <ResultRow
        label="Team strength"
        awayValue={formatRuns(projections.offense.awayTeamStrengthRating)}
        homeValue={formatRuns(projections.offense.homeTeamStrengthRating)}
      />
      <ResultRow
        label="Offense rating used"
        awayValue={formatRuns(projections.offense.awayEffectiveRating)}
        homeValue={formatRuns(projections.offense.homeEffectiveRating)}
      />
      <ResultRow
        label="Starter strikeouts"
        awayValue={formatRuns(projections.strikeouts.awayStarter)}
        homeValue={formatRuns(projections.strikeouts.homeStarter)}
      />
      <ResultRow
        label="Ks Last Outing"
        awayValue={awayLastOuting}
        homeValue={homeLastOuting}
      />
    </aside>
  );
}

export default ProjectionResults;
