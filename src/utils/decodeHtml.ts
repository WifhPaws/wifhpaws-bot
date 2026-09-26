import he from 'he';

/**
 * Decode HTML entities returned by the Open Trivia DB.
 * Example: "&quot;Hello&quot;" => "\"Hello\""
 */
export const decodeHtml = (input: string): string => he.decode(input);
