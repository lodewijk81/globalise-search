from flask import Flask, request, Response
import requests

app = Flask(__name__)

API_URL = "https://index.globalise.huygens.knaw.nl/documents/_search"


@app.route("/search", methods=["POST"])
def search():
    print("Received request from browser/client")
    print("Request body:", request.data.decode("utf-8"))

    response = requests.post(
        API_URL,
        headers={"Content-Type": "application/json"},
        data=request.data,
    )

    print("Elasticsearch status:", response.status_code)
    print("Elasticsearch response:", response.text[:1000])

    return Response(
        response.content,
        status=response.status_code,
        content_type="application/json",
    )


@app.route("/<path:path>", methods=["OPTIONS"])
def options(path):
    response = Response(status=204)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


if __name__ == "__main__":
    app.run(port=5050, debug=True)
