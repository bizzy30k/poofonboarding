#!/usr/bin/env python3
"""
Builds Poof-Retailer-Onboarding-Tracker.xlsx.

Columns are taken verbatim from TRACKER_COLUMNS in lib/tracker.js — the API
appends rows in exactly this order, so the two must not drift. If you add a
column, add it at the end in both places.
"""

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import CellIsRule

# Must match TRACKER_COLUMNS in lib/tracker.js
COLUMNS = [
    "Submission ID",
    "Signed up (UTC)",
    "Status",
    "Store name",
    "Banner locations",
    "Primary city",
    "AGCO licence",
    "AGCO status",
    "Hours",
    "Store phone",
    "Website",
    "Owner name",
    "Owner email",
    "Owner phone",
    "POS",
    "Payment processor",
    "E-commerce platform",
    "Offers delivery",
    "Delivery software",
    "Wants delivery",
    "Integrations pending",
    "Surfaces",
    "Referral code",
    "Referring brand",
    "Credit months",
    "Card on file",
    "Stripe customer",
    "Stripe subscription",
    "Go-live date",
    "Agreement sent",
    "Notes",
]

def COL(name):
    """Column letter for a header name — never hardcode letters, so inserting a
    column can't silently shift every dashboard formula."""
    return get_column_letter(COLUMNS.index(name) + 1)


WIDTHS = [18, 18, 26, 26, 9, 15, 22, 15, 42, 15, 26, 20, 26, 15, 13, 18,
          16, 9, 18, 14, 30, 26, 13, 18, 8, 10, 22, 22, 12, 13, 34]

INK, MAGENTA, MUTED = "FF0B0A14", "FFF72585", "FF6F6B85"
HEADER_FILL = PatternFill("solid", fgColor=INK)
BAND_FILL = PatternFill("solid", fgColor="FFF7F5FA")
INPUT_FILL = PatternFill("solid", fgColor="FFFFF9E0")
THIN = Side(style="thin", color="FFD8D5E0")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

F = "Arial"
STATUSES = ["Awaiting card", "Onboarded — pending go-live", "Live", "Cancelled", "Churned"]

wb = Workbook()

# ───────────────────────── Onboarded stores ─────────────────────────
ws = wb.active
ws.title = "Onboarded stores"

ws["A1"] = "Poof Retail Network — onboarded stores"
ws["A1"].font = Font(name=F, size=15, bold=True, color=INK)
ws["A2"] = ("Rows 4 down are written automatically by the onboarding flow. "
            "Only the shaded columns are yours to edit by hand.")
ws["A2"].font = Font(name=F, size=9, italic=True, color=MUTED)
ws.merge_cells("A1:H1")
ws.merge_cells("A2:N2")

HEADER_ROW = 3
for i, name in enumerate(COLUMNS, start=1):
    c = ws.cell(row=HEADER_ROW, column=i, value=name)
    c.font = Font(name=F, size=9, bold=True, color="FFFFFFFF")
    c.fill = HEADER_FILL
    c.alignment = Alignment(vertical="center", wrap_text=True)
    c.border = BORDER
    ws.column_dimensions[get_column_letter(i)].width = WIDTHS[i - 1]
ws.row_dimensions[HEADER_ROW].height = 32

# One example row, so the expected format for each column is unambiguous.
EXAMPLE = [
    "onb_mf2k91xq", "2026-08-14 14:22:07", "Onboarded — pending go-live",
    "The We Store", 9, "Windsor", "CRSA1172749", "authorized",
    "9 AM to 11 PM Monday through Saturday, and 10 AM to 9 PM Sunday",
    "519-555-0142", "https://thewestore.com", "Dana Whitfield",
    "dana@thewestore.ca", "519-555-0142", "Greenline", "Merrco", "Buddi", "Yes",
    "Canfleet", "Already delivers", "Greenline, Buddi, Canfleet", "Marketplace, Ad network",
    "BUZZD", "Buzz'd", 3, "Yes", "cus_QxAmpLe123", "", "", "2026-08-14",
    "EXAMPLE ROW — delete before use",
]
for i, v in enumerate(EXAMPLE, start=1):
    c = ws.cell(row=4, column=i, value=v)
    c.font = Font(name=F, size=9, italic=True, color=MUTED)
    c.alignment = Alignment(vertical="top", wrap_text=(i in (9, 20, 21, 30)))
    c.border = BORDER

# Formatting and banding for the rows the API will fill.
for r in range(5, 405):
    for i in range(1, len(COLUMNS) + 1):
        c = ws.cell(row=r, column=i)
        c.font = Font(name=F, size=9)
        c.border = BORDER
        c.alignment = Alignment(vertical="top", wrap_text=(i in (9, 20, 21, 30)))
        if r % 2 == 1:
            c.fill = BAND_FILL

# Hand-edited columns: Go-live date, Notes.
for col in (COL("Go-live date"), COL("Notes")):
    for r in range(4, 405):
        ws[f"{col}{r}"].fill = INPUT_FILL

dv_status = DataValidation(type="list", formula1='"' + ",".join(STATUSES) + '"', allow_blank=True)
dv_status.error = "Pick a status from the list."
ws.add_data_validation(dv_status)
dv_status.add(f'{COL("Status")}4:{COL("Status")}404')

for colname, opts in (("POS", ["Cova", "Greenline", "Other"]),
                      ("Payment processor", ["Merrco", "Moneris", "BlazePay", "CovaPay", "Other"]),
                      ("E-commerce platform", ["Buddi", "Dutchie", "Breadstack", "Just our POS menu", "Other"]),
                      ("Offers delivery", ["Yes", "No"]),
                      ("Delivery software", ["Canfleet", "Something else", "In-house (no software)"]),
                      ("Wants delivery", ["Already delivers", "Yes", "No"]),
                      ("Card on file", ["Yes", "No"])):
    letter = COL(colname)
    dv = DataValidation(type="list", formula1='"' + ",".join(opts) + '"', allow_blank=True)
    ws.add_data_validation(dv)
    dv.add(f"{letter}4:{letter}404")

ws.conditional_formatting.add(
    f'{COL("Status")}4:{COL("Status")}404',
    CellIsRule(operator="equal", formula=['"Live"'],
               font=Font(name=F, size=9, bold=True, color="FF11734B"),
               fill=PatternFill("solid", fgColor="FFD6F3E4")))
ws.conditional_formatting.add(
    f'{COL("Status")}4:{COL("Status")}404',
    CellIsRule(operator="equal", formula=['"Awaiting card"'],
               font=Font(name=F, size=9, color="FF8A5A00"),
               fill=PatternFill("solid", fgColor="FFFDF0D5")))
ws.conditional_formatting.add(
    f'{COL("Status")}4:{COL("Status")}404',
    CellIsRule(operator="equal", formula=['"Cancelled"'],
               font=Font(name=F, size=9, color="FF9B1C4A"),
               fill=PatternFill("solid", fgColor="FFFBE0EC")))

ws.freeze_panes = "E4"
ws.auto_filter.ref = f"A{HEADER_ROW}:{get_column_letter(len(COLUMNS))}404"

# ───────────────────────────── Dashboard ────────────────────────────
dash = wb.create_sheet("Dashboard")
dash["A1"] = "Pipeline at a glance"
dash["A1"].font = Font(name=F, size=15, bold=True, color=INK)
dash["A2"] = "Every figure is a live formula over 'Onboarded stores'. Nothing here is typed."
dash["A2"].font = Font(name=F, size=9, italic=True, color=MUTED)

DATA = "'Onboarded stores'"
ROWS = "$5:$404"  # row 4 is the example row and is excluded on purpose


def block(title, start, pairs, width_a=32):
    dash[f"A{start}"] = title
    dash[f"A{start}"].font = Font(name=F, size=11, bold=True, color=MAGENTA)
    for i, (label, formula) in enumerate(pairs, start=start + 1):
        dash[f"A{i}"] = label
        dash[f"A{i}"].font = Font(name=F, size=10)
        dash[f"B{i}"] = formula
        dash[f"B{i}"].font = Font(name=F, size=10, bold=True)
        dash[f"B{i}"].alignment = Alignment(horizontal="right")
    return start + len(pairs) + 2


col = lambda name: f"{DATA}!${COL(name)}$5:${COL(name)}$404"

nxt = block("Funnel", 4, [
    ("Stores onboarded", f'=COUNTA({col("Submission ID")})'),
    ("Awaiting card", f'=COUNTIF({col("Status")},"Awaiting card")'),
    ("Pending go-live", f'=COUNTIF({col("Status")},"Onboarded — pending go-live")'),
    ("Live", f'=COUNTIF({col("Status")},"Live")'),
    ("Cancelled", f'=COUNTIF({col("Status")},"Cancelled")'),
    ("Doors covered (all locations)", f'=SUM({col("Banner locations")})'),
    ("Doors live", f'=SUMIF({col("Status")},"Live",{col("Banner locations")})'),
])

nxt = block("Point of sale", nxt, [
    ("Cova", f'=COUNTIF({col("POS")},"Cova")'),
    ("Greenline", f'=COUNTIF({col("POS")},"Greenline")'),
    ("Other / write-in", f'=COUNTIF({col("POS")},"?*")-COUNTIF({col("POS")},"Cova")-COUNTIF({col("POS")},"Greenline")'),
])

nxt = block("Payment processor", nxt, [
    ("Merrco", f'=COUNTIF({col("Payment processor")},"Merrco")'),
    ("Moneris", f'=COUNTIF({col("Payment processor")},"Moneris")'),
    ("BlazePay", f'=COUNTIF({col("Payment processor")},"BlazePay")'),
    ("CovaPay", f'=COUNTIF({col("Payment processor")},"CovaPay")'),
    ("Other / write-in", f'=COUNTIF({col("Payment processor")},"?*")-COUNTIF({col("Payment processor")},"Merrco")-COUNTIF({col("Payment processor")},"Moneris")-COUNTIF({col("Payment processor")},"BlazePay")-COUNTIF({col("Payment processor")},"CovaPay")'),
])

nxt = block("Integrations to build", nxt, [
    ("On Buddi", f'=COUNTIF({col("E-commerce platform")},"Buddi")'),
    ("On Dutchie", f'=COUNTIF({col("E-commerce platform")},"Dutchie")'),
    ("On Breadstack", f'=COUNTIF({col("E-commerce platform")},"Breadstack")'),
    ("Offer delivery", f'=COUNTIF({col("Offers delivery")},"Yes")'),
    ("Using Canfleet", f'=COUNTIF({col("Delivery software")},"Canfleet")'),
    ("Using Onfleet", f'=COUNTIF({col("Delivery software")},"Onfleet")'),
    ("Delivery, other software", f'=COUNTIF({col("Delivery software")},"?*")-COUNTIF({col("Delivery software")},"Canfleet")-COUNTIF({col("Delivery software")},"Onfleet")-COUNTIF({col("Delivery software")},"In-house (no software)")'),
    ("Delivery, in-house", f'=COUNTIF({col("Delivery software")},"In-house (no software)")'),
    ("No delivery, wants it", f'=COUNTIF({col("Wants delivery")},"Yes")'),
])

nxt = block("Referrals", nxt, [
    ("Referred signups", f'=COUNTIF({col("Referral code")},"?*")'),
    ("Distinct referring brands", f'=SUMPRODUCT(({col("Referring brand")}<>"")/COUNTIF({col("Referring brand")},{col("Referring brand")}&""))'),
    ("Credit months committed", f'=SUM({col("Credit months")})'),
])

block("Hygiene", nxt, [
    ("Missing AGCO licence", f'=COUNTIFS({col("Submission ID")},"?*",{col("AGCO licence")},"")'),
    ("Card on file missing", f'=COUNTIFS({col("Submission ID")},"?*",{col("Card on file")},"No")'),
    ("Agreement not sent", f'=COUNTIFS({col("Submission ID")},"?*",{col("Agreement sent")},"")'),
    ("Live but no subscription", f'=COUNTIFS({col("Status")},"Live",{col("Stripe subscription")},"")'),
])

dash.column_dimensions["A"].width = 34
dash.column_dimensions["B"].width = 14

# ────────────────────────────── Legend ──────────────────────────────
leg = wb.create_sheet("How this works")
leg["A1"] = "How this tracker works"
leg["A1"].font = Font(name=F, size=15, bold=True, color=INK)

NOTES = [
    ("Where the rows come from",
     "The onboarding flow writes a row when a retailer finishes signup and their card is "
     "vaulted with Stripe. api/webhook.js calls appendToTracker() in lib/tracker.js."),
    ("Updates, not duplicates",
     "Rows are keyed on Submission ID (column A). A repeat write for the same ID updates "
     "that row in place, so Stripe webhook retries can't duplicate a store."),
    ("Column order is a contract",
     "These headers match TRACKER_COLUMNS in lib/tracker.js exactly. Adding a column in "
     "one place and not the other will shift every value. Add new columns at the end, in both."),
    ("What you edit by hand",
     "The shaded columns — Go-live date (AB) and Notes (AD). Everything else is written by the "
     "flow and will be overwritten on the next update for that store."),
    ("Status values",
     "Awaiting card · Onboarded — pending go-live · Live · Cancelled · Churned. "
     "'Live' is set by api/activate.js, which is also what starts billing."),
    ("Row 4 is an example",
     "It shows the expected format for every column and is excluded from all Dashboard "
     "formulas, which start at row 5. Delete it once real rows land."),
    ("Using Google Sheets instead",
     "Upload this file to Drive and open as a Sheet, then set TRACKER_SHEET_ID to the Sheet's "
     "id and share it with your service account's email as an Editor. The API writes to the tab "
     "named in TRACKER_SHEET_TAB, which defaults to 'Onboarded stores'."),
    ("Capacity",
     "Formatting and validation run to row 404. Extend the ranges here and in the Dashboard "
     "formulas when you pass 400 stores."),
]

r = 3
for title, body in NOTES:
    leg[f"A{r}"] = title
    leg[f"A{r}"].font = Font(name=F, size=10, bold=True, color=MAGENTA)
    leg[f"A{r}"].alignment = Alignment(vertical="top")
    leg[f"B{r}"] = body
    leg[f"B{r}"].font = Font(name=F, size=10)
    leg[f"B{r}"].alignment = Alignment(wrap_text=True, vertical="top")
    leg.row_dimensions[r].height = 44
    r += 1

leg.column_dimensions["A"].width = 30
leg.column_dimensions["B"].width = 92

wb.save("/mnt/user-data/outputs/Poof-Retailer-Onboarding-Tracker.xlsx")
print("written")
