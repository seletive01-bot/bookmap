import os
import json
from datetime import datetime

from flask import (
    Flask, request, jsonify, render_template,
    send_from_directory, abort
)
from pymongo import MongoClient, GEOSPHERE
from dotenv import load_dotenv
from bson import ObjectId
from bson.errors import InvalidId
from werkzeug.utils import secure_filename

import cloudinary
import cloudinary.uploader

load_dotenv()

# --------------------------------------------------
# Flask App
# --------------------------------------------------
app = Flask(__name__)

# --------------------------------------------------
# MongoDB Setup
# --------------------------------------------------
MONGO_URI = os.getenv("MONGO_URI")
MONGO_DB = os.getenv("MONGO_DB", "bookmap")

client = MongoClient(MONGO_URI)
db = client[MONGO_DB]
books_col = db["books"]

# GEO index
books_col.create_index([("locations.geo", GEOSPHERE)])

# --------------------------------------------------
# Cloudinary Config (PDF uploads)
# --------------------------------------------------
cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET"),
    secure=True,
)

# --------------------------------------------------
# Local PDF fallback
# --------------------------------------------------
ALLOWED_EXTENSIONS = {"pdf"}
UPLOAD_FOLDER = os.path.join(app.root_path, "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# --------------------------------------------------
# HOME PAGE (NO LOGIN)
# --------------------------------------------------
@app.route("/")
def home():
    return render_template("index.html")


# --------------------------------------------------
# PDF Serve + Reader Page
# --------------------------------------------------
@app.route("/pdf/<path:filename>")
def serve_pdf(filename):
    return send_from_directory(app.config["UPLOAD_FOLDER"], filename)


@app.route("/book/<book_id>")
def read_book(book_id):
    try:
        oid = ObjectId(book_id)
    except InvalidId:
        abort(404)

    book = books_col.find_one({"_id": oid})
    if not book:
        abort(404)

    pdf_url = None
    if book.get("pdf_file"):
        if book["pdf_file"].startswith("http"):
            pdf_url = book["pdf_file"]
        else:
            pdf_url = "/pdf/" + book["pdf_file"]

    return render_template("reader.html", book=book, pdf_url=pdf_url)


# --------------------------------------------------
# API — Add Book (JSON Only)
# --------------------------------------------------
@app.route("/api/book", methods=["POST"])
def add_book_json():
    data = request.json or {}

    required = ["title", "author", "locations"]
    for field in required:
        if field not in data:
            return jsonify({"error": f"{field} is required"}), 400

    books_col.insert_one(data)
    return jsonify({"status": "success"}), 201


# --------------------------------------------------
# API — Add Book + PDF Upload
# --------------------------------------------------
@app.route("/api/book-with-pdf", methods=["POST"])
def add_book_with_pdf():
    raw = request.form.get("data")
    if not raw:
        return jsonify({"error": "Missing data"}), 400

    try:
        data = json.loads(raw)
    except:
        return jsonify({"error": "Invalid JSON"}), 400

    for field in ["title", "author", "locations"]:
        if field not in data:
            return jsonify({"error": f"{field} is required"}), 400

    pdf_file = request.files.get("pdf_file")
    pdf_url = None

    if pdf_file and pdf_file.filename:
        if not allowed_file(pdf_file.filename):
            return jsonify({"error": "Only PDF allowed"}), 400

        # Try Cloudinary
        try:
            upload_result = cloudinary.uploader.upload(
              pdf_file,
              folder="bookmap/pdfs",
              resource_type="raw",
              use_filename=False,
              unique_filename=True,
              overwrite=False
           )

            pdf_url = upload_result["secure_url"]

        except Exception as e:
           print("Cloudinary failed → using local:", e)

           safe = secure_filename(pdf_file.filename)
           unique = f"{datetime.utcnow().timestamp()}_{safe}"
           local_path = os.path.join(app.config["UPLOAD_FOLDER"], unique)
           pdf_file.save(local_path)
           pdf_url = unique


    if pdf_url:
        data["pdf_file"] = pdf_url

    books_col.insert_one(data)
    return jsonify({"status": "success"}), 201


# --------------------------------------------------
# Format location data
# --------------------------------------------------
def normalize_locations(doc):
    out = []
    for loc in doc.get("locations", []):
        try:
            lng, lat = loc["geo"]["coordinates"]
            out.append({
                "lat": lat,
                "lng": lng,
                "place_name": loc.get("place_name"),
                "country": loc.get("country")
            })
        except:
            pass
    return out


# --------------------------------------------------
# API — Books in BBOX
# --------------------------------------------------
@app.route("/api/books-in-bbox", methods=["GET"])
def books_in_bbox():
    try:
        min_lng = float(request.args.get("min_lng"))
        min_lat = float(request.args.get("min_lat"))
        max_lng = float(request.args.get("max_lng"))
        max_lat = float(request.args.get("max_lat"))
    except:
        return jsonify({"error": "Invalid BBOX"}), 400

    query = {
        "locations.geo": {
            "$geoWithin": {
                "$box": [
                    [min_lng, min_lat],
                    [max_lng, max_lat]
                ]
            }
        }
    }

    cursor = books_col.find(query).limit(300)

    books = []
    for doc in cursor:
        books.append({
            "id": str(doc["_id"]),
            "title": doc.get("title"),
            "author": doc.get("author"),
            "year": doc.get("year"),
            "description": doc.get("description"),
            "tags": doc.get("tags", []),
            "category": doc.get("category"),
            "cover_url": doc.get("cover_url"),
            "pdf_file": doc.get("pdf_file"),
            "locations": normalize_locations(doc)
        })

    return jsonify({"count": len(books), "books": books})


# --------------------------------------------------
# API — Global Search
# --------------------------------------------------
@app.route("/api/search", methods=["GET"])
def search_books():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"books": []})

    query = {
        "$or": [
            {"title": {"$regex": q, "$options": "i"}},
            {"author": {"$regex": q, "$options": "i"}},
            {"tags": {"$regex": q, "$options": "i"}},
            {"category": {"$regex": q, "$options": "i"}},
            {"description": {"$regex": q, "$options": "i"}},
        ]
    }

    cursor = books_col.find(query).limit(150)

    books = []
    for doc in cursor:
        books.append({
            "id": str(doc["_id"]),
            "title": doc.get("title"),
            "author": doc.get("author"),
            "year": doc.get("year"),
            "description": doc.get("description"),
            "tags": doc.get("tags", []),
            "category": doc.get("category"),
            "cover_url": doc.get("cover_url"),
            "pdf_file": doc.get("pdf_file"),
            "locations": normalize_locations(doc)
        })

    return jsonify({"books": books})


# --------------------------------------------------
# Run Server
# --------------------------------------------------
if __name__ == "__main__":
    app.run(debug=True)
