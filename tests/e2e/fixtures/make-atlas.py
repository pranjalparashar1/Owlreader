"""Regenerates atlas.pdf, the e2e fixture: 300 A5 pages of selectable text, pages 101-120 a
taller, narrower size (to exercise lazy page sizes), and two coloured boxes on page 1.
Usage: python3 tests/e2e/fixtures/make-atlas.py  (needs reportlab)"""
from pathlib import Path
from reportlab.lib.pagesizes import A5
from reportlab.pdfgen import canvas

out = Path(__file__).with_name('atlas.pdf')
c = canvas.Canvas(str(out), pagesize=A5)
c.setTitle('Sample Atlas')
c.setAuthor('OwlReader Tests')
c.setCreator('OwlReader e2e')
c.setProducer('OwlReader e2e')
for i in range(1, 301):
    size = (420, 900) if 101 <= i <= 120 else A5
    c.setPageSize(size)
    w, h = size
    c.setFont('Times-Roman', 14)
    c.drawString(40, h - 60, f'Chapter {i}')
    c.drawString(40, h - 90, 'The army marched from Blenheim toward Mercury Bay.')
    c.drawString(40, h - 110, f'This is page {i} of the sample atlas.')
    if i == 1:
        c.setFillColorRGB(0.85, 0.1, 0.1)
        c.rect(40, 200, 120, 80, fill=1, stroke=0)
        c.setFillColorRGB(0.1, 0.3, 0.85)
        c.rect(200, 200, 120, 80, fill=1, stroke=0)
    c.showPage()
c.save()
