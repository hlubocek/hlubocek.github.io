# -*- coding: utf-8 -*-
"""Vygeneruje Rybarsky-rad-Hlubocek.pdf v kořeni projektu (text sjednocený s aplikací Hluboček)."""
import os
import sys
from datetime import date

from fpdf import FPDF

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FONT = os.path.join(os.path.dirname(__file__), "fonts", "DejaVuSans.ttf")
OUT = os.path.join(ROOT, "Rybarsky-rad-Hlubocek.pdf")


def main() -> None:
    if not os.path.isfile(FONT):
        print("Chybí font:", FONT, file=sys.stderr)
        sys.exit(1)

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()
    pdf.add_font("DejaVu", "", FONT)
    pdf.set_font("DejaVu", "", 11)

    def p(text: str) -> None:
        pdf.multi_cell(0, 6, text)
        pdf.ln(2)

    def h2(title: str) -> None:
        pdf.ln(3)
        pdf.set_font("DejaVu", "", 13)
        pdf.multi_cell(0, 7, title)
        pdf.set_font("DejaVu", "", 11)
        pdf.ln(1)

    pdf.set_font("DejaVu", "", 16)
    pdf.multi_cell(0, 8, "Rybářský řád – rybník Hluboček")
    pdf.set_font("DejaVu", "", 11)
    pdf.ln(2)
    p(
        "Výtah z pravidel pro rybolov na rybníku Hluboček a pro evidenci v aplikaci Hluboček. "
        "Závazné je plné znění řádu schválené místním rybářským spolkem; tento dokument shrnuje "
        "hlavní povinnosti uživatelů aplikace."
    )
    p(f"Verze textu v PDF: {date.today().isoformat()}")

    h2("1. Kdo může lovit")
    p(
        "Rybolov na rybníku Hluboček je určen pouze držitelům platných povolenek "
        "(členům místního rybářského spolku), v souladu s řádem spolku."
    )

    h2("2. Kapr – přisvojení")
    p(
        "Při přisvojení kapra platí míra těla 45–60 cm. "
        "Dospělý držitel povolenky: nejvýše 3 ks za kalendářní rok, nejvýše 1 ks za den. "
        "Dítě ve věku 8–14 let: nejvýše 1 ks za kalendářní rok. "
        "Každou přisvojenou rybu je nutné v aplikaci zapsat v den ulovení (zápis úlovku)."
    )

    h2("3. Návštěvy")
    p(
        "Návštěva může lovit pouze v doprovodu držitele povolenky (hostitele). "
        "Poplatek za návštěvu činí 300 Kč za 24 hodin lovu podle řádu. "
        "Poplatek hradí návštěva hostiteli; hostitel jej neprodleně předá správci rybníka. "
        "Návštěva si nesmí přisvojit žádnou rybu."
    )

    h2("4. Evidence v aplikaci Hluboček")
    p(
        "Aplikace slouží k evidenci členů, docházky (příchody k vodě), úlovků a návštěv. "
        "Docházku zapisujte ihned po příchodu k vodě. "
        "Úlovky a návštěvy evidujte v aplikaci v den ulovení / návštěvy."
    )

    h2("5. Doplňující ustanovení")
    p(
        "Dodržujte pokyny správce rybníka a aktuální plné znění rybářského řádu spolku. "
        "V případě rozporu mezi tímto výtahem a řádem platí znění řádu spolku."
    )

    pdf.output(OUT)
    print("Uloženo:", OUT)


if __name__ == "__main__":
    main()
