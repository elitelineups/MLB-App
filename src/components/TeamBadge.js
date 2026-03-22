import { getTeamLogoUrl } from '../utils/mlb';

function TeamBadge({ abbreviation, name, compact = false }) {
  const logoUrl = getTeamLogoUrl(abbreviation);

  return (
    <div className={`team-badge ${compact ? 'compact' : ''}`}>
      {logoUrl ? <img className="team-badge-logo" src={logoUrl} alt={`${name || abbreviation} logo`} /> : null}
      <span className="team-badge-code">{abbreviation}</span>
    </div>
  );
}

export default TeamBadge;
