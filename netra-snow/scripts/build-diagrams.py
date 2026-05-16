"""Generate diagram PNGs for the Netra Technical Design Document.

Writes to netra-snow/docs/diagrams/.
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "docs", "diagrams")
os.makedirs(OUT_DIR, exist_ok=True)

# Brand palette
BG          = (255, 255, 255)
BLUE        = (26, 86, 219)
DARK        = (14, 46, 122)
LIGHT_BLUE  = (239, 246, 255)
GREEN       = (5, 122, 85)
LIGHT_GREEN = (220, 252, 231)
AMBER       = (181, 71, 8)
LIGHT_AMBER = (254, 243, 199)
RED         = (200, 30, 30)
LIGHT_RED   = (254, 226, 226)
PURPLE      = (91, 33, 182)
LIGHT_PURPLE= (243, 232, 255)
GREY        = (71, 85, 105)
LIGHT_GREY  = (226, 232, 240)
TEXT        = (15, 23, 42)

# Try to load a nice font; fall back gracefully
def font(size, bold=False):
    candidates = []
    if bold:
        candidates = ["arialbd.ttf", "calibrib.ttf", "DejaVuSans-Bold.ttf"]
    else:
        candidates = ["arial.ttf", "calibri.ttf", "DejaVuSans.ttf"]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default()

F_TITLE = font(20, bold=True)
F_BOX_TITLE = font(14, bold=True)
F_BOX = font(12)
F_LABEL = font(11)
F_SMALL = font(10)

def rounded_box(draw, xy, fill, outline, width=2, radius=14):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)

def text_center(draw, xy, text, fnt, fill=TEXT):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    w = bbox[2] - bbox[0]; h = bbox[3] - bbox[1]
    x = (xy[0] + xy[2] - w) / 2; y = (xy[1] + xy[3] - h) / 2
    draw.text((x, y), text, fill=fill, font=fnt)

def text_left(draw, xy, text, fnt, fill=TEXT, padding=10):
    draw.text((xy[0] + padding, xy[1] + padding), text, fill=fill, font=fnt)

def arrow(draw, p1, p2, color=DARK, width=2, head=10):
    draw.line([p1, p2], fill=color, width=width)
    # head
    import math
    angle = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    x = p2[0]; y = p2[1]
    a1 = angle + math.radians(150); a2 = angle - math.radians(150)
    draw.polygon([
        (x, y),
        (x + head * math.cos(a1), y + head * math.sin(a1)),
        (x + head * math.cos(a2), y + head * math.sin(a2)),
    ], fill=color)

# =============================================================
# Diagram 1 — System architecture
# =============================================================
def architecture():
    W, H = 1400, 900
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((20, 16), "Netra — System Architecture", fill=DARK, font=F_TITLE)

    # Big container 1: Browser
    rounded_box(d, (20, 60, W-20, 280), LIGHT_BLUE, BLUE, width=3, radius=20)
    d.text((40, 76), "Browser  (Chrome / Edge / Safari)", fill=BLUE, font=F_BOX_TITLE)

    # Widget box
    rounded_box(d, (60, 120, 700, 250), (255,255,255), BLUE, width=2)
    d.text((80, 132), "Service Portal Page  ·  netra-mic widget", fill=DARK, font=F_BOX_TITLE)
    text_left(d, (80, 160, 700, 250), "• continuous wake-word listener\n• Web Speech STT (browser-native)\n• SpeechSynthesis TTS (Indian-English voice)\n• polls /notifications every 8 s\n• ARIA live regions + Alt+N hotkey", F_BOX)

    # Outside arrow showing it talks to instance
    arrow(d, (380, 250), (380, 320), color=DARK, width=3, head=14)
    d.text((400, 268), "POST  /api/<scope>/voice/command\nGET   /api/<scope>/voice/notifications", fill=GREY, font=F_SMALL)

    # Big container 2: ServiceNow Instance
    rounded_box(d, (20, 320, W-20, H-20), LIGHT_GREEN, GREEN, width=3, radius=20)
    d.text((40, 336), "ServiceNow Instance  (scope x_<companyId>_netra)", fill=GREEN, font=F_BOX_TITLE)

    # Scripted REST API box
    rounded_box(d, (60, 384, 380, 460), (255,255,255), GREEN, width=2)
    text_center(d, (60, 384, 380, 460), "Scripted REST API\n/command  ·  /notifications", F_BOX)

    arrow(d, (220, 462), (220, 510), color=GREEN, width=2)

    # NetraIntent --> NetraResponder --> NetraTools row
    rounded_box(d, (60, 510, 220, 580), LIGHT_AMBER, AMBER, width=2)
    text_center(d, (60, 510, 220, 580), "NetraIntent\n(regex parser)", F_BOX)
    rounded_box(d, (240, 510, 400, 580), LIGHT_AMBER, AMBER, width=2)
    text_center(d, (240, 510, 400, 580), "NetraResponder\n(spoken replies)", F_BOX)
    rounded_box(d, (420, 510, 580, 580), LIGHT_AMBER, AMBER, width=2)
    text_center(d, (420, 510, 580, 580), "NetraTools\n(GlideRecord)", F_BOX)

    arrow(d, (220, 580), (220, 600), color=AMBER)
    arrow(d, (320, 580), (320, 600), color=AMBER)
    arrow(d, (500, 580), (500, 600), color=AMBER)

    # Helpers row
    helpers = [
        ("NetraKnowledge", "kb search"),
        ("NetraChat",      "Connect read/send"),
        ("NetraContext",   "focus memory"),
        ("NetraSummarizer","extractive"),
        ("NetraNavigator", "portal URLs"),
    ]
    x = 60
    for name, sub in helpers:
        rounded_box(d, (x, 605, x+170, 670), (255,255,255), AMBER, width=1)
        text_center(d, (x, 605, x+170, 670), name + "\n" + sub, F_SMALL)
        x += 180

    # Right side: tables + scanner + BR
    rounded_box(d, (1000, 384, W-40, 470), LIGHT_PURPLE, PURPLE, width=2)
    text_center(d, (1000, 384, W-40, 470), "Scheduled Job  ·  Netra Watch\n(every 3 minutes  ->  NetraScanner)", F_BOX)

    rounded_box(d, (1000, 485, W-40, 565), LIGHT_RED, RED, width=2)
    text_center(d, (1000, 485, W-40, 565), "Business Rule\n(sys_journal_field)\nasync after insert", F_BOX)

    # Notification queue table
    rounded_box(d, (1000, 580, W-40, 660), (255,255,255), DARK, width=2)
    text_center(d, (1000, 580, W-40, 660), "<scope>_notification  (queue)\nuser, ticket, kind, message, delivered", F_BOX)

    # Arrows scanner + BR -> queue
    arrow(d, (1180, 470), (1180, 500), color=PURPLE, width=2)
    arrow(d, (1180, 565), (1180, 580), color=RED, width=2)

    # Tables
    rounded_box(d, (600, 605, 980, 670), (255,255,255), DARK, width=1)
    text_center(d, (600, 605, 980, 670), "Custom tables\n<scope>_user_pref   ·   _context   ·   _watchlist", F_SMALL)

    # Widget polls queue (back to browser)
    arrow(d, (1200, 660), (1200, 760), color=GREEN, width=2)
    d.text((1010, 700), "GET /notifications\n(polled every 8s)", fill=GREY, font=F_SMALL)
    rounded_box(d, (1000, 760, W-40, 830), LIGHT_GREEN, DARK, width=2)
    text_center(d, (1000, 760, W-40, 830), "Widget speaks the notification\n(unless paused)", F_BOX)

    out = os.path.join(OUT_DIR, "architecture.png")
    img.save(out, "PNG")
    return out

# =============================================================
# Diagram 2 — Sequence: voice command
# =============================================================
def sequence_command():
    W, H = 1400, 720
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((20, 16), "Sequence — Voice Command", fill=DARK, font=F_TITLE)

    # Actors
    actors = [("User",       100, BLUE),
              ("Widget",     360, BLUE),
              ("Browser STT",620, DARK),
              ("REST API",   880, GREEN),
              ("Intent+Tools",1180,AMBER)]
    LIFELINE_TOP = 80; LIFELINE_BOTTOM = H - 40
    for name, x, color in actors:
        rounded_box(d, (x-90, LIFELINE_TOP-30, x+90, LIFELINE_TOP+10), color, color, width=0)
        text_center(d, (x-90, LIFELINE_TOP-30, x+90, LIFELINE_TOP+10), name, F_BOX_TITLE, fill=(255,255,255))
        # Lifeline
        for yy in range(LIFELINE_TOP+10, LIFELINE_BOTTOM, 10):
            d.line([(x, yy), (x, yy+4)], fill=GREY, width=1)

    # Sequence events
    events = [
        ("User",        "Widget",     'says "Netra"',                         BLUE),
        ("Widget",      "Browser STT", "start SpeechRecognition",              BLUE),
        ("User",        "Widget",     'says "resolve INC0001234"',            BLUE),
        ("Browser STT", "Widget",     "onresult(transcript)",                 DARK),
        ("Widget",      "REST API",   "POST /command { transcript }",         GREEN),
        ("REST API",    "Intent+Tools","NetraIntent.parse() -> resolve",      AMBER),
        ("Intent+Tools","REST API",   "NetraTools.resolveTicket()",           AMBER),
        ("REST API",    "Widget",     "{ message: 'Ticket I N C ...' }",      GREEN),
        ("Widget",      "User",       "speak via SpeechSynthesis",            BLUE),
    ]
    actor_x = {name: x for name, x, _ in actors}
    y = LIFELINE_TOP + 60
    for src, dst, label, color in events:
        x1 = actor_x[src]; x2 = actor_x[dst]
        if x1 == x2:
            # self-message
            d.line([(x1, y), (x1+40, y)], fill=color, width=2)
            d.line([(x1+40, y), (x1+40, y+18)], fill=color, width=2)
            arrow(d, (x1+40, y+18), (x1, y+18), color=color, width=2, head=8)
            d.text((x1+50, y-12), label, fill=GREY, font=F_SMALL)
            y += 50
        else:
            arrow(d, (x1, y), (x2, y), color=color, width=2, head=10)
            midx = (x1+x2)/2
            bbox = d.textbbox((0,0), label, font=F_SMALL)
            tw = bbox[2] - bbox[0]
            d.text((midx - tw/2, y-16), label, fill=GREY, font=F_SMALL)
            y += 50

    out = os.path.join(OUT_DIR, "sequence-command.png")
    img.save(out, "PNG")
    return out

# =============================================================
# Diagram 3 — Sequence: proactive notification
# =============================================================
def sequence_proactive():
    W, H = 1400, 720
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    d.text((20, 16), "Sequence — Proactive Notification (assignment)", fill=DARK, font=F_TITLE)

    actors = [
        ("Assigner",     130,  DARK),
        ("ServiceNow DB",430,  GREEN),
        ("Scheduled Job",730,  PURPLE),
        ("Notif. queue", 1030, AMBER),
        ("Widget",       1280, BLUE),
    ]
    LIFELINE_TOP = 80; LIFELINE_BOTTOM = H - 40
    for name, x, color in actors:
        rounded_box(d, (x-100, LIFELINE_TOP-30, x+100, LIFELINE_TOP+10), color, color, width=0)
        text_center(d, (x-100, LIFELINE_TOP-30, x+100, LIFELINE_TOP+10), name, F_BOX_TITLE, fill=(255,255,255))
        for yy in range(LIFELINE_TOP+10, LIFELINE_BOTTOM, 10):
            d.line([(x, yy), (x, yy+4)], fill=GREY, width=1)

    events = [
        ("Assigner",      "ServiceNow DB",  "set incident.assigned_to = me", DARK),
        ("Scheduled Job", "ServiceNow DB",  "(every 3 min) scan assignments", PURPLE),
        ("ServiceNow DB", "Scheduled Job",  "rows since last_scan_time",     PURPLE),
        ("Scheduled Job", "Notif. queue",   "INSERT  message + ticket_number", AMBER),
        ("Widget",        "Notif. queue",   "GET /notifications (every 8s)", BLUE),
        ("Notif. queue",  "Widget",         "{ notifications: [...] }",       AMBER),
        ("Widget",        "Widget",         "speak via SpeechSynthesis",      BLUE),
    ]
    actor_x = {name: x for name, x, _ in actors}
    y = LIFELINE_TOP + 60
    for src, dst, label, color in events:
        x1 = actor_x[src]; x2 = actor_x[dst]
        if x1 == x2:
            d.line([(x1, y), (x1+50, y)], fill=color, width=2)
            d.line([(x1+50, y), (x1+50, y+18)], fill=color, width=2)
            arrow(d, (x1+50, y+18), (x1, y+18), color=color, width=2, head=8)
            d.text((x1+60, y-12), label, fill=GREY, font=F_SMALL)
            y += 55
        else:
            arrow(d, (x1, y), (x2, y), color=color, width=2, head=10)
            midx = (x1+x2)/2
            bbox = d.textbbox((0,0), label, font=F_SMALL)
            tw = bbox[2] - bbox[0]
            d.text((midx - tw/2, y-16), label, fill=GREY, font=F_SMALL)
            y += 65

    out = os.path.join(OUT_DIR, "sequence-proactive.png")
    img.save(out, "PNG")
    return out

# =============================================================
# Diagram 4 — Data model (ERD-like)
# =============================================================
def data_model():
    W, H = 1200, 700
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((20, 16), "Netra — Data Model", fill=DARK, font=F_TITLE)

    def table_box(x, y, w, h, title, columns):
        rounded_box(d, (x, y, x+w, y+h), (255,255,255), DARK, width=2)
        rounded_box(d, (x, y, x+w, y+34), BLUE, DARK, width=2)
        text_center(d, (x, y, x+w, y+34), title, F_BOX_TITLE, fill=(255,255,255))
        yy = y + 44
        for col, ctype in columns:
            d.text((x+12, yy), col, fill=TEXT, font=F_BOX)
            bbox = d.textbbox((0,0), ctype, font=F_SMALL)
            d.text((x+w-bbox[2]-12, yy+2), ctype, fill=GREY, font=F_SMALL)
            yy += 22

    table_box(40, 80, 320, 300, "<scope>_notification", [
        ("user",          "reference sys_user"),
        ("ticket_sys_id", "string(32)"),
        ("ticket_number", "string(32)"),
        ("kind",          "string(40)"),
        ("message",       "string(1000)"),
        ("delivered",     "boolean"),
        ("delivered_at",  "datetime"),
    ])
    table_box(420, 80, 340, 340, "<scope>_user_pref", [
        ("user",              "reference sys_user"),
        ("active",            "boolean"),
        ("paused_until",      "datetime"),
        ("last_scan_time",    "datetime"),
        ("watch_assignments", "boolean"),
        ("watch_comments",    "boolean"),
        ("watch_approvals",   "boolean"),
        ("voice_mode",        "string(20)"),
    ])
    table_box(820, 80, 340, 300, "<scope>_context", [
        ("user",           "reference sys_user"),
        ("focus_table",    "string(40)"),
        ("focus_sys_id",   "string(32)"),
        ("focus_number",   "string(32)"),
        ("focus_set_at",   "datetime"),
        ("last_utterance", "string(1000)"),
    ])
    table_box(220, 440, 340, 220, "<scope>_watchlist", [
        ("user",          "reference sys_user"),
        ("record_table",  "string(40)"),
        ("record_sys_id", "string(32)"),
        ("record_number", "string(32)"),
    ])

    # connect user references with hint lines
    d.text((600, 470), "Every table references sys_user via 'user'.\nNo foreign keys among the custom tables — joined by user at query time.",
           fill=GREY, font=F_SMALL)

    out = os.path.join(OUT_DIR, "data-model.png")
    img.save(out, "PNG")
    return out

# =============================================================
# Diagram 5 — Widget mockup
# =============================================================
def widget_mockup():
    W, H = 900, 540
    img = Image.new("RGB", (W, H), (15, 20, 38))
    d = ImageDraw.Draw(img)
    d.text((20, 16), "Widget Mockup — Floating Dock", fill=(238, 238, 255), font=F_TITLE)

    # Browser frame
    rounded_box(d, (40, 70, W-40, H-40), (250, 250, 250), DARK, width=3, radius=18)
    # Address bar
    rounded_box(d, (60, 90, W-60, 120), (235, 240, 250), GREY, width=1, radius=6)
    d.text((76, 96), "https://your-instance.service-now.com/sp", fill=GREY, font=F_SMALL)

    # Sample page content
    d.text((76, 150), "Welcome, Priya", fill=TEXT, font=F_BOX_TITLE)
    rounded_box(d, (76, 180, 460, 240), LIGHT_BLUE, BLUE, width=1, radius=10)
    d.text((92, 195), "INC0001234  ·  VPN keeps dropping every 10 min", fill=DARK, font=F_BOX)
    rounded_box(d, (76, 250, 460, 310), LIGHT_BLUE, BLUE, width=1, radius=10)
    d.text((92, 265), "INC0001235  ·  Cannot access shared drive", fill=DARK, font=F_BOX)

    # Floating dock — bottom right
    DX, DY = W-380, H-130
    rounded_box(d, (DX, DY, DX+320, DY+60), (255,255,255), BLUE, width=3, radius=40)
    # mic
    d.ellipse((DX+8, DY+5, DX+58, DY+55), fill=BLUE, outline=DARK, width=2)
    text_center(d, (DX+8, DY+5, DX+58, DY+55), "🎙", F_BOX_TITLE, fill=(255,255,255))
    # Name + status
    d.text((DX+74, DY+10), "Netra", fill=DARK, font=F_BOX_TITLE)
    d.text((DX+74, DY+32), "ready", fill=GREY, font=F_SMALL)
    # Buttons
    rounded_box(d, (DX+170, DY+15, DX+208, DY+45), (255,255,255), BLUE, width=2, radius=40)
    text_center(d, (DX+170, DY+15, DX+208, DY+45), "ON", F_SMALL, fill=BLUE)
    d.ellipse((DX+218, DY+15, DX+248, DY+45), fill=(255,255,255), outline=BLUE, width=2)
    text_center(d, (DX+218, DY+15, DX+248, DY+45), "II", F_SMALL, fill=BLUE)
    d.ellipse((DX+258, DY+15, DX+288, DY+45), fill=(255,255,255), outline=BLUE, width=2)
    text_center(d, (DX+258, DY+15, DX+288, DY+45), "?", F_BOX, fill=BLUE)

    # Hint
    d.text((DX+74, DY+70), "Press Alt+N to talk", fill=GREY, font=F_SMALL)

    out = os.path.join(OUT_DIR, "widget-mockup.png")
    img.save(out, "PNG")
    return out

if __name__ == "__main__":
    for name, func in [
        ("architecture",     architecture),
        ("sequence-command", sequence_command),
        ("sequence-proactive", sequence_proactive),
        ("data-model",       data_model),
        ("widget-mockup",    widget_mockup),
    ]:
        path = func()
        print(f"  wrote {os.path.basename(path)}  ({os.path.getsize(path):,} bytes)")
