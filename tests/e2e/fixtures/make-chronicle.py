"""Regenerates chronicle.pdf, the X-Ray and Clip & Export fixture: 12 A5 pages of flowing prose
with named people, places, organisations and coined terms ("Bumpgate", "CUDA"), a running header
and page numbers (for the stitcher's void removal), headings in bold, a numbered list, and a
paragraph that runs from the bottom of page 5 onto page 6 with a hyphenated line break, and a
binding-gutter rule down the inner edge of page 8 (export must keep the margins even around the text),
and an outline with one entry per chapter heading.
Usage: python3 tests/e2e/fixtures/make-chronicle.py  (needs reportlab)"""
from pathlib import Path
from reportlab.lib.pagesizes import A5
from reportlab.pdfgen import canvas

W, H = A5
LEFT, TOP, BOTTOM, LINE = 44, H - 78, 70, 17

PAGES = {
    1: [('h', 'Chapter One: Santa Clara'),
        ('p', 'Jensen Huang founded Nvidia in 1993 with two fellow engineers. The company began in a rented office in Santa Clara, where the founders sketched graphics chips on napkins.'),
        ('p', 'Early customers were game studios. Sega paid for the first design, and the team learned quickly that shipping on time mattered more than any single feature.')],
    2: [('p', 'By 1999 the GeForce line had made Nvidia famous among gamers. Engineers in Santa Clara worked with TSMC in Taiwan, which manufactured every chip the company sold.'),
        ('p', 'Jensen Huang liked to say that the company was always thirty days from going out of business.')],
    3: [('h', 'Chapter Two: The Defect'),
        ('p', 'In 2008 a packaging flaw in laptop chips, later dubbed Bumpgate, cost Nvidia hundreds of millions of dollars. Dell and Apple shipped machines that failed after a few months of heat.'),
        ('p', 'The underfill material between the chip and its package cracked under stress, and TSMC and Nvidia argued for months about who was to blame.')],
    4: [('p', 'Analysts in New York wrote that Bumpgate might end the company. Jensen Huang instead flew to Taipei to meet the engineers at TSMC and rework the packaging.'),
        ('p', 'The new process took most of a year to qualify.')],
    5: [('h', 'Chapter Three: CUDA'),
        ('p', 'CUDA was launched in 2006 so that researchers could program graphics chips like ordinary processors. At first almost nobody used it.'),
        ('list', ['Write the kernel in a C dialect.', 'Copy the data to the graphics card.', 'Launch thousands of threads at once.']),
        ('gap', 110),
        ('p', 'The breakthrough came from academic labs, where students discovered that training neural networks on a single graphics card was faster than renting an entire cluster of servers, and the de-'),
        ],
    6: [('cont', 'mand that followed reshaped the company for the next decade.'),
        ('p', 'Researchers in Toronto used two GeForce cards to win an image recognition contest in 2012.')],
    7: [('p', 'Years later, executives still mentioned Bumpgate as the moment the company learned to check every supplier.'),
        ('p', 'Nvidia opened new offices in Tel Aviv and Bangalore.')],
    8: [('p', 'The data centre business grew faster than gaming. Microsoft and Amazon bought chips by the thousand.')],
    9: [('p', 'A board member once joked that Bumpgate had taught Jensen Huang more than any success.')],
    10: [('p', 'TSMC built new fabs in Arizona to serve American customers.')],
    11: [('p', 'The company headquarters in Santa Clara was rebuilt around two triangular buildings.')],
    12: [('h', 'Epilogue'), ('p', 'Nvidia became one of the most valuable companies in the world.')],
}


def wrap(c, text, font, size, width):
    words, line, out = text.split(' '), '', []
    for w in words:
        trial = f'{line} {w}'.strip()
        if c.stringWidth(trial, font, size) > width and line:
            out.append(line)
            line = w
        else:
            line = trial
    if line:
        out.append(line)
    return out


out = Path(__file__).with_name('chronicle.pdf')
c = canvas.Canvas(str(out), pagesize=A5)
c.setTitle('The Chip Chronicle')
c.setAuthor('OwlReader Tests')
c.setSubject('Nvidia')
c.setCreator('OwlReader e2e')
c.setProducer('OwlReader e2e')
width = W - LEFT * 2
for n in range(1, 13):
    c.setFont('Helvetica', 8)
    c.drawCentredString(W / 2, H - 36, 'THE CHIP CHRONICLE')
    c.drawCentredString(W / 2, 34, str(n))
    if n == 8:
        c.setLineWidth(0.8)
        c.setStrokeGray(0.55)
        c.line(14, 60, 14, H - 60)
    y = TOP
    for kind, body in PAGES[n]:
        if kind == 'h':
            key = f'ch{n}'
            c.bookmarkPage(key)
            c.addOutlineEntry(body, key, level=0)  # the chapters menu (1.8.2)
            y -= 6
            c.setFont('Times-Bold', 16)
            c.drawString(LEFT, y, body)
            y -= LINE * 1.6
            continue
        if kind == 'gap':
            y -= body
            continue
        if kind == 'list':
            c.setFont('Times-Roman', 12)
            for i, item in enumerate(body, 1):
                c.drawString(LEFT + 12, y, f'{i}. {item}')
                y -= LINE
            y -= LINE * 0.5
            continue
        c.setFont('Times-Roman', 12)
        lines = wrap(c, body, 'Times-Roman', 12, width)
        for i, ln in enumerate(lines):
            c.drawString(LEFT + (14 if kind == 'p' and i == 0 else 0), y, ln)
            y -= LINE
        y -= LINE * 0.5
    c.showPage()
c.save()
