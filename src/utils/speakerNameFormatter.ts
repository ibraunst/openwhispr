/**
 * Extract and format speaker names from emails.
 * - chris.jang@toptal.com → Chris Jang
 * - ada.he@toptal.com → Ada He
 * - Guest 3 → Guest 3 (unchanged)
 * - Ian → Ian (unchanged)
 */
export function formatSpeakerName(name: string): string {
  if (!name) return name;

  // If it's an email, extract the part before @
  const emailPart = name.includes("@") ? name.split("@")[0] : name;

  // Title-case each word (split by dot or space)
  const separator = emailPart.includes(".") ? "." : " ";
  return emailPart
    .split(separator)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(separator === "." ? " " : " ");
}

// Header labels that look like `**Label:**` but aren't speakers.
const NON_SPEAKER_LABELS = new Set(["Date", "Attendees", "Subject"]);

/**
 * Format a transcript (plus optional export header) for writing to a file:
 * `**chris.jang@toptal.com:**` speaker labels and the `**Attendees:**` list
 * become display names. In-app views format at render time, but exported
 * files are read elsewhere, so the formatting has to be baked in. Stored
 * transcripts/headers stay raw — this runs only at file-write time.
 */
export function formatTranscriptForExport(text: string): string {
  return text
    .replace(/^(\*\*Attendees:\*\*\s*)(.+)$/m, (_full, prefix: string, list: string) =>
      prefix +
      list
        .split(/,\s*/)
        .map((entry) => formatSpeakerName(entry.trim()))
        .join(", ")
    )
    .replace(/\*\*([^*\n]+):\*\*/g, (full, label: string) =>
      NON_SPEAKER_LABELS.has(label) ? full : `**${formatSpeakerName(label)}:**`
    );
}
