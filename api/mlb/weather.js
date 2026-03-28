const SPORTS_INSIGHTS_MLB_EVENTS_URL = 'https://account.sportsinsights.com/wp/api/events/sport/3';

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mapWeatherCondition(summary = '', stadiumTypeDisplay = '') {
  const normalized = normalizeName(summary);
  const stadium = normalizeName(stadiumTypeDisplay);

  if (stadium.includes('dome') || stadium.includes('roof closed')) {
    return 'dome';
  }
  if (normalized.includes('rain') || normalized.includes('storm') || normalized.includes('showers')) {
    return 'rain';
  }
  if (normalized.includes('humid')) {
    return 'humid';
  }
  if (normalized.includes('cloud')) {
    return 'cloudy';
  }
  return 'clear';
}

function mapWindDirection(adjWindBearing) {
  const bearing = Number(adjWindBearing);
  if (!Number.isFinite(bearing)) {
    return 'neutral';
  }

  const normalized = ((bearing % 360) + 360) % 360;
  if (normalized <= 35 || normalized >= 325) {
    return 'out';
  }
  if (normalized >= 145 && normalized <= 215) {
    return 'in';
  }
  return 'cross';
}

function buildSportsInsightsWeather(event) {
  const gameTimeWeather =
    event?.WeatherItems?.find((item) => item?.IsGameTime) ||
    event?.Weather ||
    event?.WeatherItems?.[0] ||
    null;

  if (!gameTimeWeather) {
    return null;
  }

  return {
    source: 'Sports Insights',
    sourceUrl: 'https://www.sportsinsights.com/mlb/weather/',
    summary: cleanText(gameTimeWeather.Summary),
    temperature: Math.round(Number(gameTimeWeather.Temperature)),
    windMph: Math.round(Number(gameTimeWeather.WindSpeed)),
    windDirection: mapWindDirection(gameTimeWeather.AdjWindBearing),
    condition: mapWeatherCondition(gameTimeWeather.Summary, event?.Venue?.StadiumTypeDisplay),
    venue: cleanText(event?.Venue?.VenueName || event?.StadiumName),
    raw: {
      adjWindBearing: Number(gameTimeWeather.AdjWindBearing),
      stadiumTypeDisplay: cleanText(event?.Venue?.StadiumTypeDisplay),
      weatherTime: gameTimeWeather.WeatherTime,
    },
  };
}

function matchesSportsInsightsEvent(event, awayTeam, homeTeam, date) {
  const awayMatch = normalizeName(event?.VisitorTeam) === normalizeName(awayTeam);
  const homeMatch = normalizeName(event?.HomeTeam) === normalizeName(homeTeam);
  const eventDate = String(event?.EventDateTime || '').slice(0, 10);
  return awayMatch && homeMatch && (!date || eventDate === date);
}

module.exports = async function handler(req, res) {
  const awayTeam = cleanText(req.query?.awayTeam);
  const homeTeam = cleanText(req.query?.homeTeam);
  const date = String(req.query?.date || '').slice(0, 10);

  if (!awayTeam || !homeTeam) {
    return res.status(400).json({
      weather: null,
      error: 'Both awayTeam and homeTeam are required.',
    });
  }

  try {
    const response = await fetch(SPORTS_INSIGHTS_MLB_EVENTS_URL, {
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return res.status(502).json({
        weather: null,
        error: 'Sports Insights weather request failed.',
      });
    }

    const payload = await response.json();
    const events = Array.isArray(payload?.EventDetails) ? payload.EventDetails : [];
    const matchingEvent = events.find((event) => matchesSportsInsightsEvent(event, awayTeam, homeTeam, date));

    if (!matchingEvent) {
      return res.status(200).json({
        weather: null,
        error: 'No Sports Insights weather matchup was found for this game.',
      });
    }

    return res.status(200).json({
      weather: buildSportsInsightsWeather(matchingEvent),
      error: '',
    });
  } catch (_error) {
    return res.status(502).json({
      weather: null,
      error: 'Unable to retrieve Sports Insights weather right now.',
    });
  }
};
