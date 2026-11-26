"""Merge Intelligence Lab: standalone research, evaluation and feedback application.

The Lab is a graphical shell around the offline research backend in research/intelligence
(package `mi`). It never reimplements an algorithm: every analysis runs the same `mi` code
the command-line prototype runs.
"""

APP_NAME = "Merge Intelligence Lab"
APP_VERSION = "0.1.0"
WORKSPACE_SCHEMA = "merge.lab.workspace/1"
EXPERIMENT_SCHEMA = "merge.lab.experiment/1"
FEEDBACK_SCHEMA = "merge.lab.feedback/1"
LISTENING_SCHEMA = "merge.lab.listening/1"
PACKAGE_SCHEMA = "merge.lab.research-package/1"
