#!/usr/bin/env python3

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
ABBREVIATION_MAP = {
    "KCR": "KC",
    "TBR": "TB",
    "SDP": "SD",
    "SFG": "SF",
    "CHW": "CWS",
    "OAK": "ATH",
    "WAS": "WSH",
}


def normalize_abbreviation(value: str) -> str:
    raw = str(value or "").strip().upper()
    return ABBREVIATION_MAP.get(raw, raw)


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()


def load_shared_strings(workbook: ZipFile) -> list[str]:
    root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
    strings = []
    for item in root.findall("m:si", NS):
        text = "".join(node.text or "" for node in item.iterfind(".//m:t", NS))
        strings.append(text)
    return strings


def workbook_sheet_targets(workbook: ZipFile) -> dict[str, str]:
    rel_root = ET.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
    rels = {node.attrib["Id"]: node.attrib["Target"] for node in rel_root}
    wb_root = ET.fromstring(workbook.read("xl/workbook.xml"))
    sheet_targets = {}
    sheets = wb_root.find("m:sheets", NS)
    for sheet in sheets:
      rel_id = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
      sheet_targets[sheet.attrib["name"]] = f"xl/{rels[rel_id]}"
    return sheet_targets


def cell_value(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    value_node = cell.find("m:v", NS)

    if cell_type == "s" and value_node is not None:
        return shared_strings[int(value_node.text)]

    if cell_type == "inlineStr":
        inline = cell.find("m:is", NS)
        return "".join(node.text or "" for node in inline.iterfind(".//m:t", NS)) if inline is not None else ""

    return value_node.text if value_node is not None else ""


def excel_column_index(cell_reference: str) -> int:
    letters = "".join(character for character in cell_reference if character.isalpha())
    index = 0
    for character in letters:
        index = index * 26 + (ord(character.upper()) - ord("A") + 1)
    return max(index - 1, 0)


def read_sheet_rows(workbook: ZipFile, target: str, shared_strings: list[str]) -> list[list[str]]:
    root = ET.fromstring(workbook.read(target))
    sheet_data = root.find("m:sheetData", NS)
    rows = []
    for row in sheet_data.findall("m:row", NS):
        row_values: list[str] = []
        for cell in row.findall("m:c", NS):
          cell_index = excel_column_index(cell.attrib.get("r", "A1"))
          while len(row_values) <= cell_index:
              row_values.append("")
          row_values[cell_index] = cell_value(cell, shared_strings)
        rows.append(row_values)
    return rows


def build_fallback_lineups(workbook_path: str) -> dict[str, dict[str, list[str]]]:
    with ZipFile(workbook_path) as workbook:
        shared_strings = load_shared_strings(workbook)
        targets = workbook_sheet_targets(workbook)
        lineup_rows = read_sheet_rows(workbook, targets["AllLineups"], shared_strings)

    fallback_lineups: dict[str, dict[str, list[tuple[int, str]]]] = {}

    for row in lineup_rows[1:]:
        if len(row) < 4:
            continue

        team = normalize_abbreviation(row[0])
        hand = str(row[1] or "").strip().upper()
        try:
            order = int(float(row[2]))
        except Exception:
            continue
        player = str(row[3] or "").strip()

        if not team or hand not in {"R", "L"} or not player:
            continue

        fallback_lineups.setdefault(team, {}).setdefault(hand, []).append((order, player))

    return {
        team: {
            hand: [player for _, player in sorted(players, key=lambda item: item[0])[:9]]
            for hand, players in hands.items()
        }
        for team, hands in fallback_lineups.items()
    }


def build_lineup_values(lineup_rows: list[list[str]]) -> dict[str, dict[str, list[dict[str, object]]]]:
    lineup_values: dict[str, dict[str, list[tuple[int, str, float]]]] = {}

    for row in lineup_rows[1:]:
        if len(row) < 5:
            continue

        team = normalize_abbreviation(row[0])
        hand = str(row[1] or "").strip().upper()
        try:
            order = int(float(row[2]))
            rating = float(row[4])
        except Exception:
            continue
        player = str(row[3] or "").strip()

        if not team or hand not in {"R", "L"} or not player:
            continue

        lineup_values.setdefault(team, {}).setdefault(hand, []).append((order, player, rating))

    return {
        team: {
            hand: [
                {
                    "slot": order,
                    "name": player,
                    "rating": round(rating),
                }
                for order, player, rating in sorted(players, key=lambda item: item[0])[:9]
            ]
            for hand, players in hands.items()
        }
        for team, hands in lineup_values.items()
    }


def row_to_dict(headers: list[str], row: list[str]) -> dict[str, str]:
    values = row + [""] * max(0, len(headers) - len(row))
    return {headers[index]: values[index] for index in range(len(headers))}


def build_workbook_payload(workbook_path: str) -> dict[str, object]:
    with ZipFile(workbook_path) as workbook:
        shared_strings = load_shared_strings(workbook)
        targets = workbook_sheet_targets(workbook)

        all_lineups_rows = read_sheet_rows(workbook, targets["AllLineups"], shared_strings)
        params_rows = read_sheet_rows(workbook, targets["Params"], shared_strings)
        teams_rows = read_sheet_rows(workbook, targets["Teams"], shared_strings)
        pitchers_rows = read_sheet_rows(workbook, targets["Pitchers"], shared_strings)
        era_rows = read_sheet_rows(workbook, targets["ERA"], shared_strings)
        l30_rows = read_sheet_rows(workbook, targets["L30 K%"], shared_strings)
        season_k_rows = read_sheet_rows(workbook, targets["Season K %"], shared_strings)
        stats_2025_rows = read_sheet_rows(workbook, targets["2025 Stats"], shared_strings)
        ip_2025_rows = read_sheet_rows(workbook, targets["2025 IP"], shared_strings)
        ip_2026_rows = read_sheet_rows(workbook, targets["2026 IP"], shared_strings)
        csw_rows = read_sheet_rows(workbook, targets["CSW"], shared_strings)
        obp_rows = read_sheet_rows(workbook, targets["OBP"], shared_strings)
        rhp_rows = read_sheet_rows(workbook, targets["RHP"], shared_strings)
        lhp_rows = read_sheet_rows(workbook, targets["LHP"], shared_strings)
        venue_rows = read_sheet_rows(workbook, targets["Venues"], shared_strings)
        bullpen_rows = read_sheet_rows(workbook, targets["Bullpen"], shared_strings)

    fallback_lineups = build_fallback_lineups(workbook_path)
    lineup_values = build_lineup_values(all_lineups_rows)

    params = {}
    for row in params_rows:
        if len(row) >= 2 and row[0]:
            key = str(row[0]).replace("\xa0", "").strip()
            params[key] = float(row[1]) if row[1] not in {"", None} else None

    team_name_to_abbreviation = {}
    for row in teams_rows[1:]:
        if len(row) >= 2 and row[0] and row[1]:
            team_name_to_abbreviation[str(row[0]).strip()] = normalize_abbreviation(row[1])

    pitcher_meta = {}
    for row in pitchers_rows[1:]:
        if len(row) >= 3 and row[0]:
            pitcher_meta[normalize_name(row[0])] = {
                "name": str(row[0]).strip(),
                "team": normalize_abbreviation(row[1]),
                "hand": str(row[2]).strip().upper()[:1] or "R",
            }

    def build_index(rows: list[list[str]], key_index: int, value_index: int) -> dict[str, float]:
        index = {}
        for row in rows[1:]:
            if len(row) > max(key_index, value_index) and row[key_index]:
                try:
                    index[normalize_name(row[key_index])] = float(row[value_index])
                except Exception:
                    continue
        return index

    l30_k = build_index(l30_rows, 21, 6)
    season_k = build_index(season_k_rows, 66, 25)
    last_year_k = build_index(stats_2025_rows, 21, 6)
    whip_2025 = build_index(stats_2025_rows, 21, 10)
    ip_2025 = build_index(ip_2025_rows, 21, 24)
    ip_2026 = build_index(ip_2026_rows, 66, 69)
    csw = build_index(csw_rows, 1, 20)
    current_ip = {}
    era_fip = {}
    era_mlbam_id = {}
    for row in era_rows[1:]:
        if len(row) > 66 and row[66]:
            try:
                key = normalize_name(row[66])
                current_ip[key] = float(row[11]) / float(row[6])
                era_fip[key] = float(row[34])
                if len(row) > 68 and row[68] not in {"", None}:
                    era_mlbam_id[key] = int(float(row[68]))
            except Exception:
                continue

    team_obp = {}
    for row in obp_rows[1:]:
        if len(row) > 13 and row[0]:
            try:
                team_obp[normalize_abbreviation(row[0])] = float(row[13])
            except Exception:
                continue

    team_k_vs_r = {}
    for row in rhp_rows[1:]:
        if len(row) > 9 and row[0]:
            try:
                team_k_vs_r[normalize_abbreviation(row[0])] = float(row[9])
            except Exception:
                continue

    team_k_vs_l = {}
    for row in lhp_rows[1:]:
        if len(row) > 9 and row[0]:
            try:
                team_k_vs_l[normalize_abbreviation(row[0])] = float(row[9])
            except Exception:
                continue

    venue_factors = {}
    for row in venue_rows[1:]:
        if len(row) > 3 and row[2]:
            try:
                venue_factors[normalize_abbreviation(row[2])] = float(row[3])
            except Exception:
                continue

    bullpen_fip_by_team = {}
    for row in bullpen_rows[1:]:
        if len(row) > 18 and row[0]:
            try:
                bullpen_fip_by_team[normalize_abbreviation(row[0])] = float(row[18])
            except Exception:
                continue

    pitcher_lookup = {}
    for key, meta in pitcher_meta.items():
        pitcher_lookup[key] = {
            **meta,
            "mlbamId": era_mlbam_id.get(key),
            "fip": era_fip.get(key),
            "l30KRate": l30_k.get(key),
            "seasonKRate": season_k.get(key),
            "lastYearKRate": last_year_k.get(key),
            "csw": csw.get(key),
            "ip2026": ip_2026.get(key),
            "ip2025": ip_2025.get(key),
            "whip": whip_2025.get(key),
            "currentIp": current_ip.get(key),
        }

    return {
        "lineups": fallback_lineups,
        "lineupValues": lineup_values,
        "params": params,
        "teamNameToAbbreviation": team_name_to_abbreviation,
        "pitchers": pitcher_lookup,
        "teamObp": team_obp,
        "teamKVsR": team_k_vs_r,
        "teamKVsL": team_k_vs_l,
        "venueFactors": venue_factors,
        "bullpenFipByTeam": bullpen_fip_by_team,
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing workbook path", "lineups": {}}))
        return 1

    workbook_path = sys.argv[1]
    try:
        payload = build_workbook_payload(workbook_path)
    except Exception as error:
        print(json.dumps({"error": str(error), "lineups": {}, "params": {}}))
        return 1

    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
