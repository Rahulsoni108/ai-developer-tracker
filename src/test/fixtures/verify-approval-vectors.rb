# frozen_string_literal: true

# Optional interoperability verifier only. No Rails loading, network calls or app modifications.
# Requires the independently implemented native RFC 8785 mode in Ruby JSON 3.1.0.
gem "json", "3.1.0"
require "json"
require "digest"
require "time"

class RejectDuplicateKeys < Hash
  def []=(key, value)
    raise ArgumentError, "duplicate key" if key?(key)
    super
  end
end

# JSON data in this protocol uses binary64. Ruby's arbitrary-precision Integer parser
# must not give a different hash to a numeric token that ECMAScript rounds on input.
def binary64(value)
  case value
  when Hash then value.to_h { |key, item| [key, binary64(item)] }
  when Array then value.map { |item| binary64(item) }
  when Integer then value.to_f
  else value
  end
end

def canonical(input)
  value = JSON.parse(input, object_class: RejectDuplicateKeys, max_nesting: 32, allow_nan: false)
  JSON.generate(binary64(value), rfc8785: true)
end

# Mock authority fixture only: production Rails must resolve these values from its
# authenticated database, not accept this object or client claims as authorization.
def valid_approval?(item)
  event, proof, scope = item.values_at("event", "approval", "authority")
  fields = %w[approvalProtocolVersion eventId localRecordingSessionId consentReceiptId workspaceId captureApprovalReference canonicalization eventDigest]
  uuid = /\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/i
  proof.keys.sort == fields.sort && proof["approvalProtocolVersion"] == 1 && proof["canonicalization"] == "RFC8785" &&
    proof["captureApprovalReference"].is_a?(String) && proof["captureApprovalReference"].match?(uuid) &&
    proof["eventId"] == event["eventId"] && proof["localRecordingSessionId"] == event["sessionId"] &&
    proof["localRecordingSessionId"] == scope["localRecordingSessionId"] && proof["consentReceiptId"] == scope["consentReceiptId"] &&
    proof["workspaceId"] == event["workspaceId"] && proof["workspaceId"] == scope["workspaceId"] && scope["state"] == "active" &&
    scope["eventTypes"].include?(event["eventType"]) && Time.iso8601(scope["serverTime"]) < Time.iso8601(scope["endsAt"]) &&
    Time.iso8601(event["timestamp"]) >= Time.iso8601(scope["startsAt"]) && Time.iso8601(event["timestamp"]) <= Time.iso8601(scope["serverTime"]) &&
    proof["eventDigest"] == Digest::SHA256.hexdigest(canonical(JSON.generate(event)).encode("UTF-8"))
rescue StandardError
  false
end

begin
  raise "unsupported serializer" unless canonical('{"b":1.0,"a":-0.0}') == '{"a":0,"b":1}'
  path = ARGV.fetch(0, File.join(__dir__, "assessment-approval-v1.json"))
  fixture = JSON.parse(File.read(path, encoding: "UTF-8"))
  fixture.fetch("vectors").each do |vector|
    output = canonical(vector.fetch("inputJson"))
    raise "canonical mismatch" unless output == vector.fetch("canonical")
    raise "digest mismatch" unless Digest::SHA256.hexdigest(output.encode("UTF-8")) == vector.fetch("sha256")
  end
  fixture.fetch("invalidJson").each do |vector|
    rejected = false
    begin
      canonical(vector.fetch("inputJson"))
    rescue StandardError
      rejected = true
    end
    raise "invalid input accepted" unless rejected
  end
  fixture.fetch("approvalCases").each do |item|
    raise "approval mismatch" unless valid_approval?(item) == item.fetch("valid")
  end
  puts "Ruby JCS interoperability: #{fixture.fetch('vectors').length} byte/digest vectors and #{fixture.fetch('invalidJson').length} rejection vectors, and #{fixture.fetch('approvalCases').length} approval cases passed."
rescue StandardError
  warn "Ruby JCS interoperability failed. Check runtime support and shared fixtures."
  exit 1
end
