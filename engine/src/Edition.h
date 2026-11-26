// Which edition of Merge this build is.
//
//  Merge (default): the production console.
//  Merge Intelligence Beta (cmake -DMERGE_INTELLIGENCE_EDITION=ON): the same console, built as a
//  separate app (own name, bundle id and settings folder) so it installs next to Merge and can
//  never change the production app's settings, plugin list or current show. Shows and recordings
//  ("Merge Shows", "Merge Recordings") are shared on purpose, so the same shows open in both.
#pragma once

#ifndef MERGE_APP_NAME
 #define MERGE_APP_NAME "Merge"
#endif
// settings, plugin list, crash marker, current show: <user app data>/<this folder>
#ifndef MERGE_DATA_FOLDER
 #define MERGE_DATA_FOLDER "Merge"
#endif
// the engine listens on this port (or the next free one of ten)
#ifndef MERGE_DEFAULT_PORT
 #define MERGE_DEFAULT_PORT 18620
#endif
#ifndef MERGE_INTELLIGENCE
 #define MERGE_INTELLIGENCE 0
#endif
