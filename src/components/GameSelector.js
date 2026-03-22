function GameSelector({
  selectedDate,
  onDateChange,
  games,
  selectedGamePk,
  onGameChange,
  scheduleStatus,
  rotowireStatus,
  selectedGameLabel,
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Game Selector</h2>
          <p className="muted-text">{selectedGameLabel}</p>
        </div>
        <div className="status-row">
          <span className={`status-pill ${scheduleStatus.loading ? 'loading' : ''}`}>
            {scheduleStatus.loading ? 'Loading schedule...' : `${games.length} game${games.length === 1 ? '' : 's'} found`}
          </span>
          <span className={`status-pill ${rotowireStatus.loading ? 'loading' : ''}`}>
            {rotowireStatus.loading ? 'Checking RotoWire...' : rotowireStatus.error ? 'RotoWire unavailable' : 'RotoWire checked'}
          </span>
        </div>
      </div>

      <div className="selector-grid">
        <label className="field">
          <span>Date</span>
          <input type="date" value={selectedDate} onChange={(event) => onDateChange(event.target.value)} />
        </label>
        <label className="field field-wide">
          <span>MLB Game</span>
          <select value={selectedGamePk} onChange={(event) => onGameChange(event.target.value)}>
            {games.length === 0 ? (
              <option value="">No MLB games on this date</option>
            ) : (
              games.map((game) => (
                <option key={game.gamePk} value={game.gamePk}>
                  {game.awayTeam.abbreviation} at {game.homeTeam.abbreviation} - {game.gameTime} - {game.venue}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      {scheduleStatus.error ? <p className="inline-error">{scheduleStatus.error}</p> : null}
      {rotowireStatus.error ? <p className="inline-note">{rotowireStatus.error}</p> : null}
    </section>
  );
}

export default GameSelector;
