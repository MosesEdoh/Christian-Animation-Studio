import { MovieBudgetError, movieLimits, smallerMovie } from "./movieBudget";

// Shared by preflight and rendering so dialogue wrapping and timing cannot drift.
export function wrapMovieText(text: string, width: number, maxLines = movieLimits.frames * 18) {
  if (text.length > maxLines * (width + 2)) throw new MovieBudgetError(`Movie script text is too large. ${smallerMovie}`);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    let line = "";
    for (let word of paragraph.split(/\s+/)) {
      while (word.length > width) {
        if (line) { lines.push(line); line = ""; }
        lines.push(word.slice(0, width)); word = word.slice(width);
      }
      if (line && `${line} ${word}`.length > width) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) throw new MovieBudgetError(`Movie script text is too large. ${smallerMovie}`);
  }
  return lines;
}

export function movieScenePages(scene: { content: string; synopsis: string }, portrait: boolean) {
  const lines = wrapMovieText(scene.content || scene.synopsis, portrait ? 46 : 43);
  const pageSize = portrait ? 18 : 13;
  return { lines, pageSize, pageCount: Math.max(1, Math.ceil(lines.length / pageSize)) };
}

export function moviePageSeconds(duration: string, pageCount: number, lines: string[]) {
  const seconds = duration.split(":").reduce((total, part) => total * 60 + Number(part), 0) || 60;
  return Math.max(seconds / pageCount, lines.join(" ").length / 15, 5);
}
