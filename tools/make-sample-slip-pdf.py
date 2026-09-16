# A one-page sample PDF for Meta's template reviewers.
#
# Deliberately NOT a real slip. Meta keeps whatever is uploaded here and shows
# it to human reviewers, so a genuine signed slip would hand a customer's name,
# phone number and signature to a third party for no benefit at all. The
# reviewers only need to see that the attachment is a service slip document.
#
# Written as raw PDF because reportlab is not installed and one page of text
# does not justify a dependency.
import io, os

LINES = [
    (72, 760, 18, "OUTBOARD AND MARINE PTE LTD"),
    (72, 736, 12, "Service Slip (SAMPLE - not a real customer record)"),
    (72, 700, 12, "Service Slip No.:  00123"),
    (72, 680, 12, "Date Received:     16 Sep 2026"),
    (72, 660, 12, "Customer:          Sample Customer"),
    (72, 640, 12, "No. of Equipment:  2"),
    (72, 604, 12, "1.  Brushcutter - for servicing"),
    (72, 584, 12, "2.  Chainsaw - for servicing"),
    (72, 540, 10, "This is a sample document supplied for template review only."),
]


def esc(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


parts = ["BT"]
for x, y, size, text in LINES:
    parts.append("/F1 %d Tf 1 0 0 1 %d %d Tm (%s) Tj" % (size, x, y, esc(text)))
parts.append("ET")
stream = "\n".join(parts).encode("latin-1")

objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
    b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]

out = io.BytesIO()
out.write(b"%PDF-1.4\n")
offsets = []
for i, body in enumerate(objs, 1):
    offsets.append(out.tell())
    out.write(str(i).encode() + b" 0 obj\n" + body + b"\nendobj\n")
xref = out.tell()
out.write(b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n")
for off in offsets:
    out.write(("%010d 00000 n \n" % off).encode())
out.write(b"trailer\n<< /Size " + str(len(objs) + 1).encode() + b" /Root 1 0 R >>\nstartxref\n"
          + str(xref).encode() + b"\n%%EOF\n")

dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample-service-slip.pdf")
open(dest, "wb").write(out.getvalue())
print("wrote", dest, os.path.getsize(dest), "bytes")
