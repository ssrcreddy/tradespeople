import { describe, it, expect } from "vitest";
import { parseForwarded, htmlToText } from "../../src/services/forwarded.ts";
import { quoteFound, validateExtraction } from "../../src/services/extraction.ts";
import { intakeTokenOf } from "../../src/inbound.ts";

describe("parseForwarded", () => {
  it("Gmail forward: reads the customer from the forwarded From line and strips the header block", () => {
    const r = parseForwarded(`FYI see below\n\n---------- Forwarded message ---------\nFrom: Priya Shah <Priya.Shah@Example.com>\nDate: Thu, Oct 29, 2026\nSubject: EV charger\nTo: Dan <dan@x.example>\n\nHi Dan,\nWe need a charger.`);
    expect(r.contactHint).toEqual({ name: "Priya Shah", email: "priya.shah@example.com" });
    expect(r.cleanedText).toBe("Hi Dan,\nWe need a charger.");
  });

  it("Apple Mail forward", () => {
    const r = parseForwarded(`Begin forwarded message:\n\nFrom: tom@example.com\nSubject: lights\nDate: today\n\nThree pot lights please.`);
    expect(r.contactHint.email).toBe("tom@example.com");
    expect(r.cleanedText).toBe("Three pot lights please.");
  });

  it("Outlook-style header block without a marker line", () => {
    const r = parseForwarded(`From: "Linda Park" <linda.park@example.net>\nSent: Monday\nTo: Dan\nSubject: upgrade\n\nWe need 200 amp service.`);
    expect(r.contactHint).toEqual({ name: "Linda Park", email: "linda.park@example.net" });
    expect(r.cleanedText).toBe("We need 200 amp service.");
  });

  it("uses the innermost forward when forwards are nested", () => {
    const r = parseForwarded(`---------- Forwarded message ---------\nFrom: Office <office@x.example>\n\nsee below\n\n---------- Forwarded message ---------\nFrom: Real Customer <real@example.com>\n\nPlease quote a dimmer.`);
    expect(r.contactHint.email).toBe("real@example.com");
    expect(r.cleanedText).toBe("Please quote a dimmer.");
  });

  it("keeps quoted reply text (unquoted), because the request often lives there", () => {
    const r = parseForwarded(`Sounds good.\n\nOn Tue Dan wrote:\n> Thanks Tom\n>> Need a level 2 charger in the detached garage`);
    expect(r.cleanedText).toContain("Need a level 2 charger in the detached garage");
    expect(r.cleanedText).not.toContain(">");
  });

  it("plain text passes through untouched", () => {
    const r = parseForwarded("hey can u fix my lights");
    expect(r).toEqual({ contactHint: { name: null, email: null }, cleanedText: "hey can u fix my lights" });
  });
});

describe("htmlToText", () => {
  it("drops tags, scripts and entities", () => {
    expect(htmlToText(`<p>Hi&nbsp;Dan</p><script>x()</script><div>2 plugs &amp; a switch</div>`)).toBe("Hi Dan\n2 plugs & a switch");
  });
});

describe("source-quote check", () => {
  const text = "Also the plug by the kitchen sink doesnt have the safety button thing, can you swap it?";
  it("accepts verbatim and lightly paraphrased quotes, rejects invented ones", () => {
    expect(quoteFound("the plug by the kitchen sink doesnt have the safety button thing", text)).toBe(true);
    expect(quoteFound("The plug by the kitchen sink doesn't have the safety button thing", text)).toBe(true);
    expect(quoteFound("replace the panel with a 200 amp one", text)).toBe(false);
  });

  it("treats a 'stated' quantity with no number in its quote as unstated", () => {
    const v = validateExtraction({
      isEnquiry: true, customer: { name: null, email: null, phone: null, siteAddress: null },
      jobType: "x", summary: "x", urgency: "unknown", questions: [],
      lines: [{ description: "Labour", priceBookItemId: "not-mine", qty: 6, qtyStated: true, unit: "hour", kind: "labour", sourceKind: "text", sourceQuote: "swap it", confidence: 0.8 }],
    }, text, new Set(["mine"]));
    expect(v.result.lines[0]).toMatchObject({ qty: 1, qtyStated: false, priceBookItemId: null });
  });
});

describe("intake token", () => {
  it("reads the plus-address token from display-name forms", () => {
    expect(intakeTokenOf(["Dan's Intake <quote+abc123@intake.example.com>"])).toBe("abc123");
    expect(intakeTokenOf(["dan@example.com", "QUOTE+Zz9@intake.example.com"])).toBe("zz9");
    expect(intakeTokenOf(["dan@example.com"])).toBeNull();
  });
});
