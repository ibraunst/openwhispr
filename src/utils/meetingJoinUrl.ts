/**
 * Extract a joinable video-call URL from a calendar event.
 * Apple events carry the URL in hangout_link; Google events may only have
 * conferenceData entryPoints (mirrors extractMeetingUrl in meetingDetectionEngine.js).
 */
export function getMeetingJoinUrl(event: {
  hangout_link?: string | null;
  conference_data?: string | null;
}): string | null {
  if (event.hangout_link) return event.hangout_link;
  if (!event.conference_data) return null;
  try {
    const data =
      typeof event.conference_data === "string"
        ? JSON.parse(event.conference_data)
        : event.conference_data;
    return (
      data?.entryPoints?.find(
        (ep: { entryPointType: string; uri?: string }) => ep.entryPointType === "video"
      )?.uri || null
    );
  } catch {
    return null;
  }
}
