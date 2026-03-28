const cheerio = require('cheerio');

const ROTOWIRE_URL = 'https://www.rotowire.com/baseball/daily-lineups.php';

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectMatches(source, expression, group = 1) {
  const matches = [];
  let match = expression.exec(source);
  while (match) {
    matches.push(cleanText(match[group]));
    match = expression.exec(source);
  }
  return matches.filter(Boolean);
}

function parseTeamCodes(block) {
  const candidates = [
    ...collectMatches(block, /data-team-code="([^"]+)"/g),
    ...collectMatches(block, /lineup__abbr[^>]*>([^<]+)</g),
    ...collectMatches(block, /lineup__team-abbrev[^>]*>([^<]+)</g),
  ].filter((value) => value.length <= 4);

  return {
    awayAbbreviation: candidates[0] || '',
    homeAbbreviation: candidates[1] || '',
  };
}

function parseLineupNames(block) {
  const names = [
    ...collectMatches(
      block,
      /<li[^>]+class="[^"]*lineup__player[^"]*"[\s\S]*?<a[^>]+title="([^"]+)"/g
    ),
    ...collectMatches(
      block,
      /<li[^>]+class="[^"]*lineup__player[^"]*"[\s\S]*?<a[^>]*>([^<]+)<\/a>/g
    ),
    ...collectMatches(block, /lineup__player-highlight-name[^>]*>([^<]+)</g),
    ...collectMatches(block, /lineup__player-name[^>]*>([^<]+)</g),
    ...collectMatches(block, /data-rotowire-player-name="([^"]+)"/g),
  ];

  const unique = [];
  names.forEach((name) => {
    if (name && !unique.includes(name)) {
      unique.push(name);
    }
  });

  return unique.slice(0, 9).map((name, index) => ({ slot: index + 1, name }));
}

function splitGameBlocks(html) {
  const blocks = html.match(
    /<div[^>]+class="[^"]*(?:lineup__box|lineup is-mlb|lineup)[^"]*"[\s\S]*?<\/div>\s*<\/div>/g
  );
  if (!blocks || !blocks.length) {
    return [];
  }
  return blocks;
}

function parseRotowireWithRegex(html) {
  return splitGameBlocks(html)
    .map((block) => {
      const { awayAbbreviation, homeAbbreviation } = parseTeamCodes(block);
      const players = parseLineupNames(block);

      return {
        awayAbbreviation,
        homeAbbreviation,
        awayLineup: players.slice(0, 9),
        homeLineup: players.slice(9, 18),
      };
    })
    .filter((game) => game.awayAbbreviation && game.homeAbbreviation);
}

function parseRotowireWithCheerio(html) {
  const $ = cheerio.load(html);
  return $('.lineup.is-mlb')
    .map((_, element) => {
      const game = $(element);

      const awayAbbreviation =
        cleanText(game.find('.lineup__team.is-visit .lineup__abbr').first().text()) ||
        cleanText(game.attr('data-visit') || game.attr('data-away'));
      const homeAbbreviation =
        cleanText(game.find('.lineup__team.is-home .lineup__abbr').first().text()) ||
        cleanText(game.attr('data-home'));

      const awayLineup = game
        .find('.lineup__list.is-visit li.lineup__player a')
        .slice(0, 9)
        .map((idx, player) => ({ slot: idx + 1, name: cleanText($(player).text()) }))
        .get()
        .filter((player) => player.name);

      const homeLineup = game
        .find('.lineup__list.is-home li.lineup__player a')
        .slice(0, 9)
        .map((idx, player) => ({ slot: idx + 1, name: cleanText($(player).text()) }))
        .get()
        .filter((player) => player.name);

      return {
        awayAbbreviation,
        homeAbbreviation,
        awayLineup,
        homeLineup,
      };
    })
    .get()
    .filter((game) => game.awayAbbreviation && game.homeAbbreviation);
}

function parseRotowireLineups(html) {
  const cheerioGames = parseRotowireWithCheerio(html);
  if (cheerioGames.length) {
    return cheerioGames;
  }
  return parseRotowireWithRegex(html);
}

module.exports = async function handler(req, res) {
  const date = String(req.query?.date || '').slice(0, 10);
  const url = `${ROTOWIRE_URL}${date ? `?date=${encodeURIComponent(date)}` : ''}`;

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        date,
        games: [],
        error: 'RotoWire request failed.',
      });
    }

    const html = await response.text();
    const games = parseRotowireLineups(html);
    return res.status(200).json({
      date,
      games,
      error: games.length ? '' : 'RotoWire responded, but no posted lineups were parsed for this date yet.',
    });
  } catch (_error) {
    return res.status(502).json({
      date,
      games: [],
      error: 'RotoWire proxy could not retrieve lineups from the remote source.',
    });
  }
};
