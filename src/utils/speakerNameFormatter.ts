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

  // If there's a dot, split and capitalize each part (first.last → First Last)
  if (emailPart.includes(".")) {
    return emailPart
      .split(".")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  // Otherwise just capitalize the first letter
  return emailPart.charAt(0).toUpperCase() + emailPart.slice(1).toLowerCase();
}
