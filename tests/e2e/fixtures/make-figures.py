"""Regenerates figures.pdf, the dark-mode image fixture: page 1 has text, a colour photo (top
left: a sky-to-grass "landscape" with a red sun), a white-background bar chart (top right) and
a photo rotated 20° (bottom). Page 2 is a full-page scan (an image of black text on cream
paper). Dark/Black should keep the photos' colours and invert the chart, the scan and the text.
Usage: python3 tests/e2e/fixtures/make-figures.py  (needs reportlab and Pillow)"""
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import A5
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

W, H = A5
OUT = Path(__file__).with_name('figures.pdf')


def photo(w=240, h=160):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / h
        if t < 0.6:  # sky: deep blue to light blue
            c = (int(30 + 90 * t), int(80 + 120 * t), int(170 + 70 * t))
        else:  # grass
            c = (40, int(150 - 80 * (t - 0.6)), 50)
        d.line([(0, y), (w, y)], fill=c)
    d.ellipse([w * 0.65, h * 0.12, w * 0.85, h * 0.42], fill=(220, 40, 30))
    return im


def chart(w=240, h=160):
    im = Image.new('RGB', (w, h), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.line([(20, h - 20), (w - 10, h - 20)], fill=(0, 0, 0), width=2)
    d.line([(20, 10), (20, h - 20)], fill=(0, 0, 0), width=2)
    for i, (v, c) in enumerate([(0.5, (37, 99, 235)), (0.8, (220, 38, 38)), (0.35, (22, 163, 74))]):
        x = 40 + i * 60
        d.rectangle([x, h - 20 - v * (h - 40), x + 36, h - 21], fill=c)
    return im


def scan(w=600, h=850):
    im = Image.new('RGB', (w, h), (246, 240, 222))
    d = ImageDraw.Draw(im)
    for row in range(30):
        y = 60 + row * 25
        for word in range(8):
            x = 50 + word * 64
            d.rectangle([x, y, x + 50, y + 10], fill=(30, 28, 25))
    return im


def reader(im):
    buf = BytesIO()
    im.save(buf, 'PNG')
    buf.seek(0)
    return ImageReader(buf)


c = canvas.Canvas(str(OUT), pagesize=A5)
c.setTitle('Figure Sampler')
c.setFont('Helvetica-Bold', 16)
c.drawString(40, H - 50, 'Figures')
c.setFont('Helvetica', 11)
c.drawString(40, H - 70, 'A photo, a chart and a rotated photo on one page.')
c.drawImage(reader(photo()), 30, H - 230, 180, 120)
c.drawImage(reader(chart()), 230, H - 230, 180, 120)
c.saveState()
c.translate(150, 120)
c.rotate(20)
c.drawImage(reader(photo()), 0, 0, 150, 100)
c.restoreState()
c.showPage()
c.drawImage(reader(scan()), 0, 0, W, H)
c.showPage()
c.save()
print(OUT)
