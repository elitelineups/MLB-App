import TeamBadge from './TeamBadge';

function TeamEditor({
  side,
  team,
  opponent,
  title,
  teamOptions,
  onTeamChange,
  onPitcherFieldChange,
  onLineupPlayerChange,
  pitcherOptions,
  batterOptions,
  postedLineup,
  lineupStatusText,
  mismatchNote,
  availabilityNote,
  onApplyPostedLineup,
  workbookStarterFipActive,
  workbookBullpenFipActive,
}) {
  return (
    <section className="panel team-panel">
      <div className="panel-header">
        <div>
          <div className="team-panel-title">
            <h2>{title}</h2>
            <TeamBadge abbreviation={team.abbreviation} name={team.name} />
          </div>
          <p className="muted-text">
            Pitcher stays with {team.abbreviation} unless you manually change this team card.
          </p>
        </div>
        {postedLineup.length ? (
          <button className="secondary-button" type="button" onClick={() => onApplyPostedLineup(side)}>
            Replace With Posted Lineup
          </button>
        ) : null}
      </div>

      <div className="team-identity-grid">
        <label className="field">
          <span>Team</span>
          <select value={team.abbreviation} onChange={(event) => onTeamChange(side, event.target.value)}>
            {teamOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="pitcher-grid">
        <label className="field field-wide">
          <span>Probable Pitcher</span>
          <input
            list={`${side}-pitcher-options`}
            value={team.probablePitcher.name}
            onChange={(event) => onPitcherFieldChange(side, 'name', event.target.value)}
          />
          <datalist id={`${side}-pitcher-options`}>
            {pitcherOptions.map((pitcherName) => (
              <option key={`${side}-${pitcherName}`} value={pitcherName} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Batters Faced</span>
          <input
            type="number"
            min="9"
            max="30"
            step="1"
            value={team.probablePitcher.battersFaced}
            onChange={(event) => onPitcherFieldChange(side, 'battersFaced', event.target.value)}
          />
        </label>
      </div>
      <div className="pitcher-source-row">
        <span className={`source-chip ${workbookStarterFipActive ? 'active' : ''}`}>
          {workbookStarterFipActive ? 'Workbook starter FIP active' : 'Seed starter FIP active'}
        </span>
        <span className={`source-chip ${workbookBullpenFipActive ? 'active' : ''}`}>
          {workbookBullpenFipActive ? 'Workbook bullpen FIP active' : 'Seed bullpen FIP active'}
        </span>
      </div>

      <div className="lineup-header">
        <div>
          <div className="lineup-opponent">
            <h3>Lineup vs</h3>
            <TeamBadge abbreviation={opponent.abbreviation} name={opponent.name} compact />
          </div>
          <p className="muted-text">{lineupStatusText}</p>
          {availabilityNote ? <p className="availability-note">{availabilityNote}</p> : null}
        </div>
        {mismatchNote ? <span className="mismatch-pill">{mismatchNote}</span> : null}
      </div>

      <div className="lineup-grid-head">
        <span>Spot</span>
        <span>Batter Name</span>
        <span>Hitter Rating</span>
      </div>
      <div className="lineup-grid">
        {team.lineup.map((player, index) => (
          <div className="lineup-row" key={`${side}-${player.slot}`}>
            <label className="field slot-field inline-field">
              <input
                type="number"
                min="1"
                max="9"
                value={player.slot}
                onChange={(event) => onLineupPlayerChange(side, index, 'slot', event.target.value)}
              />
            </label>
            <label className="field name-field inline-field">
              <input
                list={`${side}-batter-options`}
                value={player.name}
                onChange={(event) => onLineupPlayerChange(side, index, 'name', event.target.value)}
              />
            </label>
            <label className="field rating-field inline-field">
              <input
                type="number"
                min="70"
                max="130"
                step="1"
                value={player.rating}
                onChange={(event) => onLineupPlayerChange(side, index, 'rating', event.target.value)}
              />
            </label>
          </div>
        ))}
      </div>
      <datalist id={`${side}-batter-options`}>
        {batterOptions.map((batterName) => (
          <option key={`${side}-${batterName}`} value={batterName} />
        ))}
      </datalist>
    </section>
  );
}

export default TeamEditor;
