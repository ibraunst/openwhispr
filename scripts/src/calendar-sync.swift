import Foundation
import EventKit

// Swift script to fetch Apple Calendar events quickly and output as JSON.
// Required parameters: days-ahead (e.g., 7)

let store = EKEventStore()

// Request access synchronously
let group = DispatchGroup()
var hasAccess = false

group.enter()
if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { (granted, error) in
        hasAccess = granted
        group.leave()
    }
} else {
    store.requestAccess(to: .event) { (granted, error) in
        hasAccess = granted
        group.leave()
    }
}

group.wait()

if !hasAccess {
    print("{\"error\": \"Calendar access denied. Please allow CustomWhispr to access your calendars in System Settings > Privacy & Security > Calendars.\"}")
    exit(0)
}

struct Attendee: Codable {
    let name: String?
    let email: String?
    let status: String
    let isCurrentUser: Bool
}

struct EventData: Codable {
    let uid: String
    let title: String
    let startTimestamp: Int
    let endTimestamp: Int
    let isAllDay: Bool
    let url: String?
    let location: String?
    let notes: String?
    let attendees: [Attendee]
    let attendeesCount: Int
    let isPrivate: Bool
    let organizerName: String?
    let organizerEmail: String?
}

// Arguments: days ahead (default 7)
var daysAhead = 7
if CommandLine.arguments.count > 1, let d = Int(CommandLine.arguments[1]) {
    daysAhead = d
}

let now = Date()
// Fetch events from today up to `daysAhead` days in the future
guard let endDate = Calendar.current.date(byAdding: .day, value: daysAhead, to: now) else {
    exit(1)
}

let calendars = store.calendars(for: .event)
let predicate = store.predicateForEvents(withStart: now, end: endDate, calendars: calendars)
let events = store.events(matching: predicate)

var outputEvents: [EventData] = []

for event in events {
    var attendeeList: [Attendee] = []
    
    if let attendees = event.attendees {
        for a in attendees {
            let statusStr: String
            switch a.participantStatus {
            case .accepted: statusStr = "accepted"
            case .declined: statusStr = "declined"
            case .pending: statusStr = "needsAction"
            case .tentative: statusStr = "tentative"
            case .delegated: statusStr = "delegated"
            case .completed: statusStr = "completed"
            case .inProcess: statusStr = "inProcess"
            default: statusStr = "unknown"
            }
            
            attendeeList.append(Attendee(
                name: a.name,
                email: (a.url as NSURL?)?.resourceSpecifier, // gets mailto: address specifier
                status: statusStr,
                isCurrentUser: a.isCurrentUser
            ))
        }
    }
    
    let isPrivate: Bool
    if #available(macOS 10.8, *) {
        // Unfortunately EKEvent doesn't expose a strict 'private' flag directly, but we can check the privacy level or availability if needed. In some environments the availability or structured location can hint at privacy. We'll default to false unless configured otherwise. Apple Calendar stores actual 'private' lock as part of exchange metadata not always exposed publically in EventKit, but we will add the field to the JSON schema.
        isPrivate = false // Placeholder, can refine if needed.
    } else {
        isPrivate = false
    }

    let e = EventData(
        uid: event.eventIdentifier ?? UUID().uuidString,
        title: event.title ?? "Untitled Event",
        startTimestamp: Int(event.startDate.timeIntervalSince1970 * 1000),
        endTimestamp: Int(event.endDate.timeIntervalSince1970 * 1000),
        isAllDay: event.isAllDay,
        url: event.url?.absoluteString,
        location: event.location,
        notes: event.notes,
        attendees: attendeeList,
        attendeesCount: attendeeList.count,
        isPrivate: isPrivate,
        organizerName: event.organizer?.name,
        organizerEmail: (event.organizer?.url as NSURL?)?.resourceSpecifier
    )
    outputEvents.append(e)
}

let encoder = JSONEncoder()
if let jsonData = try? encoder.encode(outputEvents),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else {
    print("[]")
}
